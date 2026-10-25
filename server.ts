import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import http from "http";
import https from "https";
import { URL } from "url";
import { Readable, PassThrough } from "stream";
import { GoogleGenAI } from "@google/genai";

const app = express();

// Port resolution:
// - AI Studio sandbox: NGINX reverse proxy runs on 8080 and forwards to 3000. Dev server MUST bind to 3000.
// - Cloud Run production: Cloud Run routes ingress traffic to process.env.PORT (defaults to 8080).
const isCloudRunProd = process.env.NODE_ENV === "production" && !process.env.NGINX_PORT;
const PORT = isCloudRunProd
  ? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8080)
  : 3000;

app.use(cors());
app.use(express.json());

// Set Permissions-Policy header to guarantee microphone access on Safari iOS & browsers
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  next();
});

// Custom HTTP/HTTPS agents with rejectUnauthorized: false for international sports streams
// Set keepAlive: false so connections are immediately closed and not kept idling on Xtream Codes servers
const sportsHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
  maxSockets: 64,
});
const sportsHttpAgent = new http.Agent({
  keepAlive: false,
  maxSockets: 64,
});

// Domain keywords for Thể Thao Quốc Tế & Xtream Codes
const INTERNATIONAL_SPORTS_DOMAINS = [
  "tharen1",
  "terranovax1",
  "antik.sk",
  "royallivetv",
  "royallivetv.club",
  ".cfd",
  ".club",
  "zalmora",
  "panaka",
  "jarvisx",
  "thobias",
  "livesport.io.vn",
  "smartvnow.xyz",
  "apolonbox",
  "watchtivo",
  "ifiesta.net",
  "zazaint.com",
  "aynaott.com",
  "amagi.tv",
];

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MAG_STALKER_USER_AGENT =
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";

// Main M3U source URL (nguồn duy nhất)
const PRIMARY_HT_TV_URL = "https://raw.githubusercontent.com/thongdp00/m3u/refs/heads/main/ht-tv.m3u";

// Local snapshot & cache directory and files
const DATA_DIR = path.resolve(process.cwd(), "data");
const SNAPSHOT_PLAYLIST_PATH = path.join(DATA_DIR, "default-playlist.m3u");
const CACHE_PLAYLIST_PATH = path.join(DATA_DIR, "cached-playlist.m3u");
const CACHE_JSON_PATH = path.join(DATA_DIR, "cached-data.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.warn("Could not create data directory:", e);
    }
  }
}

function saveLocalCache(m3uText: string, data?: any) {
  try {
    ensureDataDir();
    if (m3uText && m3uText.includes("#EXTINF")) {
      fs.writeFileSync(CACHE_PLAYLIST_PATH, m3uText, "utf-8");
    }
    if (data && data.channels && data.channels.length > 0) {
      fs.writeFileSync(CACHE_JSON_PATH, JSON.stringify(data), "utf-8");
    }
  } catch (err: any) {
    console.warn("[Cache] Không thể ghi cache M3U vào đĩa:", err?.message || err);
  }
}

function loadLocalCache(): string | null {
  try {
    if (fs.existsSync(CACHE_PLAYLIST_PATH)) {
      const text = fs.readFileSync(CACHE_PLAYLIST_PATH, "utf-8");
      if (text && text.includes("#EXTINF")) {
        return text;
      }
    }
  } catch (err: any) {
    console.warn("[Cache] Không thể đọc cache M3U từ đĩa:", err?.message || err);
  }
  return null;
}

function loadLocalSnapshot(): string {
  try {
    if (fs.existsSync(SNAPSHOT_PLAYLIST_PATH)) {
      const text = fs.readFileSync(SNAPSHOT_PLAYLIST_PATH, "utf-8");
      if (text && text.includes("#EXTINF")) {
        return text;
      }
    }
  } catch (err: any) {
    console.warn("[Snapshot] Không thể đọc backup snapshot từ đĩa:", err?.message || err);
  }
  return "";
}

/**
 * Fetch GitHub M3U with GITHUB_PAT support for private repos,
 * and automatic fallback to last cache or default snapshot file on error (401, 403, 404, timeout).
 */
async function fetchGithubM3U(url: string = PRIMARY_HT_TV_URL): Promise<{ text: string; from: "github" | "cache" | "snapshot" }> {
  const isPublicRepo = url.includes("raw.githubusercontent.com/thongdp00/m3u");
  const githubPat = !isPublicRepo ? (process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || "").trim() : "";
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/plain, */*",
  };
  if (githubPat && url.includes("github")) {
    headers["Authorization"] = `Bearer ${githubPat}`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s fast timeout
    let res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    // Nếu GitHub báo 401 hoặc 404 do token, tự động thử lại không kèm Authorization header
    if ((res.status === 401 || res.status === 404) && headers["Authorization"]) {
      delete headers["Authorization"];
      const retryController = new AbortController();
      const retryTimeout = setTimeout(() => retryController.abort(), 8000);
      res = await fetch(url, {
        headers,
        signal: retryController.signal,
      });
      clearTimeout(retryTimeout);
    }

    if (res.ok) {
      const fetchedText = await res.text();
      if (fetchedText && fetchedText.includes("#EXTINF")) {
        saveLocalCache(fetchedText);
        return { text: fetchedText, from: "github" };
      } else {
        console.warn(`[M3U Fetch] Upstream GitHub trả về nội dung không hợp lệ (Status ${res.status})`);
      }
    } else {
      console.warn(`[M3U Fetch] Gặp lỗi khi tải GitHub M3U: HTTP ${res.status} ${res.statusText}`);
    }
  } catch (err: any) {
    console.warn(`[M3U Fetch] Lỗi kết nối hoặc timeout khi tải GitHub M3U (${err?.message || err})`);
  }

  // Fallback 1: Đọc từ file cache gần nhất trên đĩa
  const cachedText = loadLocalCache();
  if (cachedText && cachedText.includes("#EXTINF")) {
    console.info("[M3U Fetch] Đã tự động fallback sang file cache M3U gần nhất trên đĩa!");
    return { text: cachedText, from: "cache" };
  }

  // Fallback 2: Đọc từ file backup snapshot mặc định (data/default-playlist.m3u)
  const snapshotText = loadLocalSnapshot();
  if (snapshotText && snapshotText.includes("#EXTINF")) {
    console.info("[M3U Fetch] Đã tự động fallback sang file backup mặc định (snapshot)!");
    return { text: snapshotText, from: "snapshot" };
  }

  return { text: "", from: "snapshot" };
}

function isTokenExpired(url: string, bufferSeconds = 15): boolean {
  if (!url) return false;
  try {
    const match = url.match(/[?&](?:expires|expire|exp)=(\d+)/i);
    if (!match) return false;
    const expiresTimestamp = parseInt(match[1], 10);
    if (isNaN(expiresTimestamp)) return false;
    const currentUnix = Math.floor(Date.now() / 1000);
    return expiresTimestamp <= currentUnix + bufferSeconds;
  } catch {
    return false;
  }
}

function isSpecialTv360Channel(name: string, url: string): boolean {
  const n = (name || "").toLowerCase();
  const u = (url || "").toLowerCase();
  return (
    n.includes("on phim việt") ||
    n.includes("on phim viet") ||
    n.includes("phim việt") ||
    n === "hitv" ||
    n.includes("hitv") ||
    n.includes("you tv") ||
    n.includes("youtv") ||
    u.includes("id=175") ||
    u.includes("id=32") ||
    u.includes("id=31") ||
    u.includes("348.m3u8") ||
    u.includes("332.m3u8") ||
    u.includes("/447/output")
  );
}

function isOnSportsTv360Channel(name: string = "", url: string = ""): boolean {
  const n = (name || "").toLowerCase().trim();
  const u = (url || "").toLowerCase();
  // If stream is MyTV Widevine (.mpd from cdn.mytvnet.vn or vstv), never treat as TV360 ClearKey
  if (u.includes("mytvnet.vn") || u.includes("vstv") || u.includes("mytv2")) {
    return false;
  }
  const isTargetId =
    u.includes("id=170") ||
    u.includes("id=173") ||
    u.includes("id=174") ||
    u.includes("id=183") ||
    u.includes("tv360170") ||
    u.includes("tv360173") ||
    u.includes("tv360174") ||
    u.includes("tv360183");
  const isTargetName =
    n === "on football" ||
    n === "on sports" ||
    n === "on sports+" ||
    n === "on sports plus" ||
    n === "on sports news" ||
    n.startsWith("on football ") ||
    n.startsWith("on sports ") ||
    n.startsWith("on sports+ ") ||
    n.startsWith("on sports news ");
  const isTv360Source = u.includes("tv360") || u.includes("cleankey");
  return isTargetId || (isTargetName && isTv360Source);
}

function getOnSportsDefaultClearKeyUrl(_name: string = "", _url: string = ""): string {
  return "";
}

function scoreStreamUrl(url: string, cleanName: string = ""): number {
  if (!url) return -9999;
  let score = 100;

  const lowerUrl = url.toLowerCase();

  // 1. Kiểm tra token hết hạn -> Loại bỏ
  if (isTokenExpired(url)) {
    return -9000;
  }

  // 2. Token còn hạn hợp lệ -> Điểm cộng lớn
  if (lowerUrl.includes("token=") || lowerUrl.includes("expires=")) {
    score += 150;
  }

  // 3. Ưu tiên các CDN chính thức tốc độ cao & ổn định nhất tại Việt Nam
  if (lowerUrl.includes("tv360.php") || lowerUrl.includes("tv360.vn") || lowerUrl.includes("vietanhtv.top/tv360")) {
    score += 300;
  } else if (lowerUrl.includes("vieon.php") || lowerUrl.includes("vieon.vn")) {
    score += 280;
  } else if (lowerUrl.includes("vtvgo") || lowerUrl.includes("vtv.vn")) {
    score += 260;
  } else if (lowerUrl.includes("vtvcab") || lowerUrl.includes("onplus")) {
    score += 250;
  } else if (lowerUrl.includes("sctv") || lowerUrl.includes("htv")) {
    score += 240;
  }

  // 4. Thể thao quốc tế: Ưu tiên link VIP trực tiếp, ổn định
  if (lowerUrl.includes("livesport.io.vn/ok/vip1.php")) {
    score += 200;
  } else if (lowerUrl.includes("livesport.io.vn/ok/stalkvip.php")) {
    score += 50;
  }

  // 5. Loại bỏ / trừ điểm nặng các nguồn dự phòng chậm, lỗi hoặc domain không ổn định
  if (
    lowerUrl.includes("watchtivo-8k.com") ||
    lowerUrl.includes("aynaott.com") ||
    lowerUrl.includes("short.gy") ||
    lowerUrl.includes("tivi-one-iptv.net")
  ) {
    score -= 400;
  }

  // 6. Ưu tiên giao thức HTTPS bảo mật & không bị Mixed Content
  if (lowerUrl.startsWith("https://")) {
    score += 40;
  }

  // 7. Ưu tiên định dạng HLS/DASH tiêu chuẩn
  if (lowerUrl.includes(".m3u8") || lowerUrl.includes(".mpd")) {
    score += 30;
  }

  return score;
}

function selectBestStreamUrl(urls: string[], cleanName: string = ""): string {
  if (!urls || urls.length === 0) return "";
  const uniqueUrls = Array.from(new Set(urls.filter(Boolean)));
  if (uniqueUrls.length === 1) return uniqueUrls[0];

  let bestUrl = uniqueUrls[0];
  let bestScore = scoreStreamUrl(bestUrl, cleanName);

  for (let i = 1; i < uniqueUrls.length; i++) {
    const s = scoreStreamUrl(uniqueUrls[i], cleanName);
    if (s > bestScore) {
      bestScore = s;
      bestUrl = uniqueUrls[i];
    }
  }

  return bestUrl;
}

// Cache container with 60-second TTL for live tokens
let cachedData: {
  timestamp: number;
  channels: any[];
  categories: any[];
  m3uText: string;
} | null = null;

const CACHE_TTL_MS = 60 * 1000; // 1 minute (luôn cập nhật token mới nhất)

function normalizeForMatching(name: string): string {
  return (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(hd|fhd|4k|sd|full hd)\b/gi, "")
    .replace(/\+/g, "plus")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function cleanChannelName(rawName: string): string {
  if (!rawName) return "Kênh TV";
  let cleaned = rawName
    .replace(/VTVcab\s*MPD\s*DRM/gi, "")
    .replace(/MPD\s*DRM/gi, "")
    .replace(/\[\s*DRM\s*\]/gi, "")
    .replace(/\(\s*DRM\s*\)/gi, "")
    .replace(/\[\s*MPD\s*\]/gi, "")
    .replace(/\(\s*MPD\s*\)/gi, "")
    .replace(/-\s*DRM/gi, "")
    .replace(/\|\s*DRM/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Chuẩn hóa tên kênh UNITE8 SPORT 1B thành UNITE8 SPORT 1
  if (/^UNITE\s*8\s*SPORT\s*1\s*B?$/i.test(cleaned)) {
    cleaned = "UNITE8 SPORT 1";
  } else if (/^UNITE\s*8\s*SPORT\s*2$/i.test(cleaned)) {
    cleaned = "UNITE8 SPORT 2";
  }

  return cleaned || rawName.trim();
}

function upgradeStreamUrl(url: string): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (trimmed.startsWith("https://") || trimmed.startsWith("//") || trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("http://")) {
    const lower = trimmed.toLowerCase();
    if (
      lower.includes("vietanhtv.top") ||
      lower.includes("vietanhtv.id.vn") ||
      lower.includes("seenow.vn") ||
      lower.includes("mytvnet.vn") ||
      lower.includes("vtvprime.vn") ||
      lower.includes("vtvgo.vn") ||
      lower.includes("vieon.vn") ||
      lower.includes("freem3u.xyz") ||
      lower.includes("githubusercontent.com")
    ) {
      return trimmed.replace(/^http:\/\//i, "https://");
    }
  }
  return trimmed;
}

function isThirdPartyApiUrl(url?: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("freem3u.xyz") ||
    lower.includes("vmttv.dpdns.org") ||
    lower.includes("?vid=") ||
    lower.includes("&vid=") ||
    lower.includes("?id=") ||
    lower.includes("&id=")
  );
}

// Fallback logos for prominent Vietnamese channels & 360 series
function getFallbackLogo(channelName: string): string {
  const n = (channelName || "").toLowerCase().trim();
  if (n.includes("vtv1")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Logo_VTV1_2013.svg/512px-Logo_VTV1_2013.svg.png";
  if (n.includes("vtv2")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Logo_VTV2_2013.svg/512px-Logo_VTV2_2013.svg.png";
  if (n.includes("vtv3")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f6/Logo_VTV3_2013.svg/512px-Logo_VTV3_2013.svg.png";
  if (n.includes("vtv4")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Logo_VTV4_2013.svg/512px-Logo_VTV4_2013.svg.png";
  if (n.includes("vtv5")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/Logo_VTV5_2013.svg/512px-Logo_VTV5_2013.svg.png";
  if (n.includes("vtv6") || n.includes("vtv can tho")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Logo_VTV_C%E1%BA%A7n_Th%C6%A1_2022.svg/512px-Logo_VTV_C%E1%BA%A7n_Th%C6%A1_2022.svg.png";
  if (n.includes("vtv7")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Logo_VTV7_2016.svg/512px-Logo_VTV7_2016.svg.png";
  if (n.includes("vtv8")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Logo_VTV8_2016.svg/512px-Logo_VTV8_2016.svg.png";
  if (n.includes("vtv9")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Logo_VTV9_2013.svg/512px-Logo_VTV9_2013.svg.png";
  if (n.includes("htv7")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/HTV7_logo_2016.svg/512px-HTV7_logo_2016.svg.png";
  if (n.includes("htv9")) return "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/HTV9_logo_2016.svg/512px-HTV9_logo_2016.svg.png";
  if (
    n.includes("thp3") ||
    n.includes("thp 3") ||
    (n.includes("thp") && (n.includes("3") || n.includes("plus"))) ||
    (n.includes("hải phòng") && (n.includes("3") || n.includes("plus")))
  ) {
    return "https://raw.githubusercontent.com/vuminhthanh12/Logo/refs/heads/main/THP3.png";
  }

  // 360 series channel logos (360 Anime, 360 Phim Việt, 360 Hoạt hình, etc.)
  if (n.includes("360 anime") || (n.includes("anime") && !n.includes("filmrise"))) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/13/13/1776063223569/462daff06d9d_640_360.png";
  }
  if (n.includes("360 phim việt") || n.includes("360 phim viet")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/07/15/1775549899305/f54a93a767c5_640_360.png";
  }
  if (n.includes("360 hoạt hình") || n.includes("360 hoat hinh")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/07/15/1775549978212/fcfc9c6d7919_640_360.png";
  }
  if (n.includes("360 phim hoa ngữ") || n.includes("360 hoa ngu")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/09/08/1775697736867/3854900b7263_640_360.png";
  }
  if (n.includes("360 hành động") || n.includes("360 hanh dong")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/08/10/1775617851169/1f38a5af77c1_640_360.png";
  }
  if (n.includes("360 hài") || n.includes("360 hai")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/13/13/1776063183880/03439dc9da19_640_360.png";
  }
  if (n.includes("360 phim kinh điển") || n.includes("360 kinh dien")) {
    return "https://img-zlr1.tv360.vn/image1/2026/04/13/13/1776063200976/6ced2ef539a4_640_360.png";
  }
  if (n.includes("360 phim 4k") || n.includes("360 4k")) {
    return "https://img-zlr1.tv360.vn/image1/2026/07/30/10/1785382803894/362700e9107b_640_360.png";
  }

  return "";
}

function parseM3USource(content: string, sourceOrigin: "ht-tv" | "vietanhtv"): any[] {
  const lines = content.split(/\r?\n/);
  const channels: any[] = [];

  let curTvgId = "";
  let curTvgName = "";
  let curTvgLogo = "";
  let curRawGroup = "";
  let curRawName = "";
  let licenseType = "none";
  let licenseKey = "";
  let licenseUrl = "";
  let manifestType = "";
  let customHeaders: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Kodi DRM properties
    if (line.startsWith("#KODIPROP:")) {
      const prop = line.substring("#KODIPROP:".length);
      const eqIdx = prop.indexOf("=");
      if (eqIdx !== -1) {
        const key = prop.substring(0, eqIdx).trim();
        const value = prop.substring(eqIdx + 1).trim();
        if (key.includes("license_type")) {
          if (value.toLowerCase().includes("clearkey") || value.toLowerCase().includes("org.w3.clearkey")) {
            licenseType = "clearkey";
          } else if (value.toLowerCase().includes("widevine") || value.toLowerCase().includes("com.widevine.alpha")) {
            licenseType = "widevine";
          }
        } else if (key.includes("license_key")) {
          if (value.startsWith("http")) {
            licenseUrl = value;
          } else {
            licenseKey = value;
          }
        } else if (key.includes("manifest_type")) {
          if (value.toLowerCase().includes("dash") || value.toLowerCase().includes("mpd")) {
            manifestType = "dash";
          }
        }
      }
      continue;
    }

    // VLC / HTTP Headers
    if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
      customHeaders["User-Agent"] = line.substring("#EXTVLCOPT:http-user-agent=".length).trim();
      continue;
    }
    if (line.startsWith("#EXTVLCOPT:http-referrer=") || line.startsWith("#EXTVLCOPT:http-referer=")) {
      customHeaders["Referer"] = line.split("=")[1].trim();
      continue;
    }

    // EXTINF Metadata
    if (line.startsWith("#EXTINF:")) {
      const infoLine = line.substring("#EXTINF:".length);
      const commaIdx = infoLine.lastIndexOf(",");
      curRawName = commaIdx !== -1 ? infoLine.substring(commaIdx + 1).trim() : "Kênh TV";

      const getAttr = (attr: string) => {
        // Hỗ trợ cả attr="value", attr=value", và attr=value (khắc phục lỗi tvg-logo=https://... không có ngoặc kép mở)
        const match =
          infoLine.match(new RegExp(`${attr}=\"([^\"]*)\"`, "i")) ||
          infoLine.match(new RegExp(`${attr}=([^\"\\s,]+)\"`, "i")) ||
          infoLine.match(new RegExp(`${attr}=([^\"\\s,]+)`, "i"));
        return match ? match[1].trim() : "";
      };

      curTvgId = getAttr("tvg-id");
      curTvgName = getAttr("tvg-name") || curRawName;
      let rawLogo = getAttr("tvg-logo") || getAttr("logo") || "";
      if (!rawLogo) {
        const directLogoMatch = infoLine.match(/tvg-logo=?\"?([^\"\s,]+)/i);
        if (directLogoMatch) rawLogo = directLogoMatch[1].replace(/\"/g, "").trim();
      }
      if (rawLogo.includes("http")) {
        const httpMatch = rawLogo.match(/(https?:\/\/[^\s"']+)/i);
        if (httpMatch) rawLogo = httpMatch[1].replace(/\"/g, "");
      }
      curTvgLogo = rawLogo;
      curRawGroup = getAttr("group-title") || getAttr("group") || "";
      continue;
    }

      // Stream URL
    if (!line.startsWith("#") && (line.startsWith("http://") || line.startsWith("https://") || line.startsWith("/"))) {
      let streamUrl = upgradeStreamUrl(line);
      const cleanName = cleanChannelName(curRawName || curTvgName);
      const normGroup = curRawGroup.normalize("NFC").toLowerCase();
      const normName = cleanName.normalize("NFC").toLowerCase();
      const lowerRawName = (curRawName || "").toLowerCase();
      const lowerRawGroup = (curRawGroup || "").toLowerCase();

      // Tách đúng ID luồng trong Playlist M3U: UNITE8 SPORT 1 (id=uni1) và UNITE8 SPORT 2 (id=uni2)
      if (
        normName.includes("unite8 sport 1") ||
        normName.includes("unite 8 sport 1") ||
        lowerRawName.includes("unite8 sport 1") ||
        lowerRawName.includes("unite 8 sport 1")
      ) {
        if (streamUrl.includes("id=uni2")) {
          streamUrl = streamUrl.replace("id=uni2", "id=uni1");
        }
      } else if (
        normName.includes("unite8 sport 2") ||
        normName.includes("unite 8 sport 2") ||
        lowerRawName.includes("unite8 sport 2") ||
        lowerRawName.includes("unite 8 sport 2")
      ) {
        if (streamUrl.includes("id=uni1")) {
          streamUrl = streamUrl.replace("id=uni1", "id=uni2");
        }
      }
      const lowerUrl = streamUrl.toLowerCase();

      // SCTV channels must NEVER be filtered out
      const isSctv =
        normName.includes("sctv") ||
        normGroup.includes("sctv") ||
        lowerRawName.includes("sctv") ||
        lowerRawGroup.includes("sctv");

      // Strictly remove and exclude any VTVPrime event channels (only by group-title or channel name)
      // Never filter by streamUrl, as SCTV streams use the vtvprime.vn CDN domain!
      const isVtvPrime =
        !isSctv &&
        (
          normGroup.includes("sự kiện vtvprime") ||
          normGroup.includes("su kien vtvprime") ||
          normGroup.includes("vtvprime") ||
          normName.includes("vtvprime") ||
          lowerRawName.includes("vtvprime") ||
          lowerRawGroup.includes("vtvprime")
        );

      if (isVtvPrime) {
        curTvgId = "";
        curTvgName = "";
        curTvgLogo = "";
        curRawGroup = "";
        curRawName = "";
        licenseType = "none";
        licenseKey = "";
        licenseUrl = "";
        customHeaders = {};
        continue;
      }

      let targetCategory: string | null = null;

      if (normGroup.includes("vtvcab") || normGroup.includes("vtv cab") || normGroup === "vtvcab" || normName.includes("vtvcab")) {
        targetCategory = "VTVCab";
      } else if (normGroup === "vtv" || (normGroup.includes("vtv") && !normGroup.includes("cab"))) {
        targetCategory = "VTV";
      } else if (normGroup === "htv" || normGroup.includes("htv")) {
        targetCategory = "HTV";
      } else if (normGroup === "sctv" || normGroup.includes("sctv")) {
        targetCategory = "SCTV";
      } else if (normGroup.includes("thể thao") || normGroup.includes("the thao") || normGroup.includes("sport")) {
        targetCategory = "Thể Thao Quốc Tế";
      } else if (normGroup.includes("địa phương") || normGroup.includes("dia phuong")) {
        targetCategory = "Địa Phương";
      } else if (normGroup.includes("phim")) {
        targetCategory = "Phim Truyện";
      } else if (normGroup.includes("nhạc") || normGroup.includes("nhac")) {
        targetCategory = "Nghe Nhạc";
      } else if (normGroup.includes("quốc tế") || normGroup.includes("quoc te")) {
        targetCategory = "Quốc Tế";
      } else if (
        normGroup.includes("tv360") ||
        normGroup.includes("sự kiện") ||
        normGroup.includes("su kien") ||
        normGroup.includes("event") ||
        normName.includes("tv360")
      ) {
        targetCategory = "Sự Kiện TV360";
      }

      if (targetCategory) {
        const isSpecialHls = isSpecialTv360Channel(cleanName, streamUrl);

        let drmInfo: any = undefined;
        if (!isSpecialHls) {
          const upgradedLicenseUrl = licenseUrl ? upgradeStreamUrl(licenseUrl) : "";
          if (licenseType !== "none" || licenseKey || upgradedLicenseUrl) {
            drmInfo = {
              type: licenseType !== "none" ? licenseType : "clearkey",
              licenseUrl: upgradedLicenseUrl || undefined,
              key: licenseKey || undefined
            };
          }
        }

        const isMusic = targetCategory === "Nghe Nhạc" && !normName.includes("on music") && !normName.includes("htvc ca nhạc");
        
        let format: "hls" | "dash" | "ts" = "hls";
        if (isSpecialHls) {
          // Standardize ON Phim Việt, HiTV, and You TV to HLS, completely eliminate DRM
          format = "hls";
          drmInfo = undefined;
          customHeaders = {
            "User-Agent": "Dalvik/2.1.0",
            "Referer": "https://tv360.vn/",
            "Origin": "https://tv360.vn"
          };
        } else {
          const isMytvWidevine =
            licenseType === "widevine" ||
            lowerUrl.includes("mytvnet.vn") ||
            lowerUrl.includes("vstv") ||
            (licenseUrl && licenseUrl.includes("mytv2"));
          const isManifestDash = manifestType === "dash";
          const isOnSports = !isMytvWidevine && (isOnSportsTv360Channel(cleanName, streamUrl) || isManifestDash);
          const isHls = !isManifestDash && !isMytvWidevine && !isOnSports && (lowerUrl.includes(".m3u8") || lowerUrl.includes("/vieon/vieon.php") || lowerUrl.includes("chunklist") || lowerUrl.includes("hls") || lowerUrl.includes("hls_clean"));
          const isTv360Event = targetCategory === "Sự Kiện TV360" || cleanName.toUpperCase().includes("TV360+") || lowerUrl.includes("live_dashdrm");
          const isDash = isManifestDash || isMytvWidevine || isOnSports || (!isHls && (lowerUrl.includes(".mpd") || lowerUrl.includes("dash") || (isTv360Event && !!drmInfo) || lowerUrl.includes("seenow.vn") || lowerUrl.includes("mytvnet.vn")));
          const isTs = !isDash && !isHls && (lowerUrl.includes(".ts") || lowerUrl.includes("extension=ts") || lowerUrl.includes("mac=") || lowerUrl.includes("play_token=") || lowerUrl.includes("/play/live.php") || lowerUrl.includes("ifiesta.net") || lowerUrl.includes("zazaint.com") || lowerUrl.includes("watchtivo") || lowerUrl.includes("tivi-one-iptv") || lowerUrl.includes(":80/") || lowerUrl.includes(":8080/"));
          format = isDash ? "dash" : isTs ? "ts" : "hls";

          if (isMytvWidevine) {
            drmInfo = {
              type: "widevine",
              licenseUrl: licenseUrl || "https://tv.vietanhtv.top/mytv2/key.php",
              key: licenseKey || undefined,
            };
            customHeaders = {
              "User-Agent": "Dalvik/2.1.0",
            };
          } else if (isOnSports) {
            const defaultKeyUrl = getOnSportsDefaultClearKeyUrl(cleanName, streamUrl);
            drmInfo = {
              type: licenseType === "widevine" ? "widevine" : "clearkey",
              licenseUrl: (licenseUrl && licenseUrl.includes("cleankey")) ? licenseUrl : (defaultKeyUrl || licenseUrl || undefined),
              key: licenseKey || undefined,
            };
            customHeaders = {
              "User-Agent": "Dalvik/2.1.0",
              "Referer": "https://tv360.vn/",
              "Origin": "https://tv360.vn"
            };
          } else if (targetCategory === "Sự Kiện TV360" || cleanName.toUpperCase().includes("TV360+")) {
            customHeaders = {
              "User-Agent": "Dalvik/2.1.0",
              "Referer": "https://tv360.vn/",
              "Origin": "https://tv360.vn"
            };
          } else if (lowerUrl.includes("mac=") || lowerUrl.includes("play_token=")) {
            customHeaders = {
              "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
              "Accept": "*/*",
            };
          }
        }

        const lowerClean = cleanName.toLowerCase();
        const isDualSource =
          lowerClean.includes("on phim việt") ||
          lowerClean.includes("on phim viet") ||
          (lowerClean.includes("phim việt") && !lowerClean.includes("vtv")) ||
          lowerClean === "hitv" ||
          lowerClean.includes("hitv") ||
          targetCategory === "Thể Thao Quốc Tế" ||
          targetCategory.toLowerCase().includes("thể thao quốc tế") ||
          /tv360\s*\+\s*([1-9]|1[0-5])\b/i.test(lowerClean) ||
          cleanName.toUpperCase().includes("TV360+") ||
          targetCategory === "Sự Kiện TV360" ||
          targetCategory === "Sự Kiện" ||
          streamUrl.toLowerCase().includes("tv360") ||
          streamUrl.toLowerCase().includes("vietanhtv") ||
          streamUrl.toLowerCase().includes("/447/output") ||
          streamUrl.toLowerCase().includes("348.m3u8");

        const cleanDirectUrl = streamUrl.replace(/^.*\/api\/(?:stream-)?proxy\?url=([^&]+).*$/, (_, enc) => decodeURIComponent(enc));
        const isThirdPartyApi = isThirdPartyApiUrl(streamUrl) || isThirdPartyApiUrl(cleanDirectUrl);

        const isViuTvSix =
          normName.includes("viutv") ||
          normName.includes("viu6") ||
          lowerRawName.includes("viutv") ||
          lowerRawName.includes("viu6") ||
          cleanDirectUrl.toLowerCase().includes("viu6") ||
          cleanDirectUrl.toLowerCase().includes("cdn.qd.je") ||
          cleanDirectUrl.toLowerCase().includes("hidns.vip");

        const isDomestic =
          !isViuTvSix &&
          !isDualSource &&
          !isThirdPartyApi &&
          (targetCategory === "VTV" ||
          targetCategory === "HTV" ||
          targetCategory === "SCTV" ||
          targetCategory === "VTVCab" ||
          targetCategory === "Địa Phương" ||
          targetCategory === "Phim Truyện" ||
          targetCategory === "Nghe Nhạc" ||
          cleanName.toLowerCase().startsWith("vtv") ||
          cleanName.toLowerCase().startsWith("htv") ||
          cleanName.toLowerCase().startsWith("sctv") ||
          cleanName.toLowerCase().startsWith("thvl"));

        const isAngiangTv =
          normName.includes("an giang 3") ||
          normName.includes("angiang 3") ||
          lowerRawName.includes("an giang 3") ||
          lowerRawName.includes("angiang 3") ||
          cleanDirectUrl.toLowerCase().includes("angiangtv.vn");

        const isRedirectOrNoCorsStream =
          cleanDirectUrl.toLowerCase().includes("tivixiaomi.vn") ||
          cleanDirectUrl.toLowerCase().includes("vietmitv") ||
          cleanDirectUrl.toLowerCase().includes("c.php?k=");

        let proxyParams = "";
        if (isAngiangTv) {
          proxyParams = `&ua=${encodeURIComponent(CHROME_USER_AGENT)}&referer=${encodeURIComponent("https://angiangtv.vn/")}`;
        } else if (isRedirectOrNoCorsStream) {
          proxyParams = "&ua=Dalvik%2F2.1.0&referer=https%3A%2F%2Ftv360.vn%2F";
        } else if (isViuTvSix) {
          proxyParams = `&referer=${encodeURIComponent("https://cdn.qd.je/163189/viu6")}`;
        } else if (
          lowerClean.includes("on phim việt") ||
          lowerClean.includes("on phim viet") ||
          lowerClean.includes("phim việt") ||
          lowerClean.includes("hitv") ||
          /tv360\s*\+\s*([1-9]|1[0-5])\b/i.test(lowerClean) ||
          cleanName.toUpperCase().includes("TV360+") ||
          targetCategory === "Sự Kiện TV360" ||
          targetCategory === "Sự Kiện" ||
          cleanDirectUrl.toLowerCase().includes("tv360") ||
          cleanDirectUrl.toLowerCase().includes("vietanhtv") ||
          isOnSportsTv360Channel(cleanName, cleanDirectUrl)
        ) {
          proxyParams = "&ua=Dalvik%2F2.1.0&referer=https%3A%2F%2Ftv360.vn%2F";
        } else if (targetCategory === "Thể Thao Quốc Tế" || targetCategory.toLowerCase().includes("thể thao quốc tế")) {
          if (cleanDirectUrl.includes("livesport")) {
            proxyParams = `&ua=${encodeURIComponent("IPTVSmartersPro/3.1.5.1 (Linux; Android 10)")}&isLivesport=1`;
          } else if (cleanDirectUrl.includes("mac=") || cleanDirectUrl.includes("play_token=")) {
            proxyParams = `&ua=${encodeURIComponent("Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3")}`;
          } else if (cleanDirectUrl.includes("zazaint.com") || cleanDirectUrl.includes("extension=ts")) {
            proxyParams = "&ua=IPTVSmartersPlayer";
          } else {
            proxyParams = "&isSports=1";
          }
        }
        const proxyUrl = `/api/stream-proxy?url=${encodeURIComponent(cleanDirectUrl)}${proxyParams}`;
        const thirdPartyProxyUrl = `/api/proxy?url=${encodeURIComponent(cleanDirectUrl)}&ua=${encodeURIComponent(customHeaders["User-Agent"] || "Dalvik/2.1.0")}&referer=https%3A%2F%2Ftv360.vn%2F`;

        const effectiveUrl = (isAngiangTv || isRedirectOrNoCorsStream)
          ? proxyUrl
          : (isThirdPartyApi ? thirdPartyProxyUrl : (isViuTvSix ? proxyUrl : (isDualSource ? proxyUrl : (isDomestic ? cleanDirectUrl : streamUrl))));
        const effectiveUrls = (isAngiangTv || isRedirectOrNoCorsStream)
          ? [proxyUrl]
          : (isThirdPartyApi ? [thirdPartyProxyUrl] : (isViuTvSix ? [proxyUrl, cleanDirectUrl] : (isDualSource ? [proxyUrl, cleanDirectUrl] : [effectiveUrl])));
        const effectiveBackups = (isAngiangTv || isRedirectOrNoCorsStream)
          ? []
          : (isThirdPartyApi ? [] : (isViuTvSix ? [cleanDirectUrl] : (isDualSource ? [cleanDirectUrl] : [])));

        const isThp3 =
          normName.includes("thp3") ||
          normName.includes("thp 3") ||
          lowerRawName.includes("thp3") ||
          lowerRawName.includes("thp 3") ||
          (normName.includes("hải phòng") && (normName.includes("3") || normName.includes("plus"))) ||
          (lowerRawName.includes("hải phòng") && (lowerRawName.includes("3") || lowerRawName.includes("plus")));

        const finalLogo = isThp3
          ? "https://raw.githubusercontent.com/vuminhthanh12/Logo/refs/heads/main/THP3.png"
          : (curTvgLogo || getFallbackLogo(cleanName));

        const newCh = {
          id: `ch_${targetCategory.toLowerCase().replace(/\s+/g, "_")}_${channels.length + 1}_${Math.floor(Math.random() * 1000)}`,
          name: curRawName,
          cleanName,
          tvgId: curTvgId,
          logo: finalLogo,
          group: targetCategory,
          url: effectiveUrl,
          urls: effectiveUrls,
          backupUrls: effectiveBackups,
          format: isSpecialHls ? "hls" : (drmInfo ? "dash" : format),
          drm: isSpecialHls ? undefined : (drmInfo || undefined),
          headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
          isMusic
        };

        // Lọc và giữ lại nguồn chất lượng tốt nhất, loại bỏ trùng lặp hoặc dự phòng lỗi
        const existingIndex = channels.findIndex(
          (c) => c.cleanName.toLowerCase() === newCh.cleanName.toLowerCase() && c.group === newCh.group
        );

        if (existingIndex >= 0) {
          const existing = channels[existingIndex];
          if (isThirdPartyApi) {
            channels[existingIndex] = {
              ...newCh,
              url: thirdPartyProxyUrl,
              urls: [thirdPartyProxyUrl],
              backupUrls: []
            };
          } else if (isDualSource || isViuTvSix) {
            channels[existingIndex] = {
              ...newCh,
              url: proxyUrl,
              urls: [proxyUrl, cleanDirectUrl],
              backupUrls: [cleanDirectUrl]
            };
          } else {
            const bestUrl = selectBestStreamUrl([existing.url, newCh.url], newCh.cleanName);
            const finalUrl = isDomestic ? bestUrl.replace(/^.*\/api\/(?:stream-)?proxy\?url=([^&]+).*$/, (_, enc) => decodeURIComponent(enc)) : bestUrl;
            if (bestUrl === newCh.url) {
              channels[existingIndex] = {
                ...newCh,
                url: finalUrl,
                urls: [finalUrl],
                backupUrls: []
              };
            } else {
              channels[existingIndex].url = finalUrl;
              channels[existingIndex].urls = [finalUrl];
              channels[existingIndex].backupUrls = [];
            }
          }
        } else {
          channels.push(newCh);
        }
      }

      // Reset state
      curTvgId = "";
      curTvgName = "";
      curTvgLogo = "";
      curRawGroup = "";
      curRawName = "";
      licenseType = "none";
      licenseKey = "";
      licenseUrl = "";
      manifestType = "";
      customHeaders = {};
    }
  }

  return deduplicateChannels(channels);
}

/**
 * Trích xuất canonical stream URL để so khớp nhận diện luồng phát trùng lặp
 */
function getCanonicalStreamUrl(url: string): string {
  if (!url) return "";
  let u = url.trim();
  if (u.includes("/api/proxy?url=") || u.includes("/api/stream-proxy?url=")) {
    try {
      const match = u.match(/[?&]url=([^&]+)/);
      if (match) u = decodeURIComponent(match[1]);
    } catch {
      // ignore
    }
  }
  return u
    .replace(/[?&](?:expires|expire|exp|token|t|sign|h)=\w+/gi, "")
    .toLowerCase()
    .trim();
}

/**
 * Lọc trùng lặp danh sách kênh theo tên kênh (cleanName/name) hoặc stream URL.
 * Đảm bảo mỗi kênh (đặc biệt các kênh TV360+1 đến TV360+15) chỉ xuất hiện một lần duy nhất.
 */
function deduplicateChannels(channels: any[]): any[] {
  if (!channels || channels.length === 0) return [];

  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  const deduplicated: any[] = [];

  for (const channel of channels) {
    if (!channel) continue;

    const rawName = (channel.cleanName || channel.name || "").trim();
    const normName = rawName.toLowerCase().replace(/\s+/g, "");
    const grp = (channel.group || "").toLowerCase().trim();
    const chId = channel.id ? String(channel.id).toLowerCase().trim() : "";
    const canonicalUrl = getCanonicalStreamUrl(channel.url);

    const nameKey = `${grp}::${normName}`;
    const isTv360Plus = normName.startsWith("tv360+");
    const tv360Key = isTv360Plus ? normName : null;

    let isDuplicate = false;

    if (tv360Key && seenKeys.has(tv360Key)) {
      isDuplicate = true;
    } else if (normName && seenKeys.has(nameKey)) {
      isDuplicate = true;
    } else if (canonicalUrl && canonicalUrl.length > 20 && seenUrls.has(canonicalUrl)) {
      isDuplicate = true;
    } else if (chId && seenIds.has(chId) && (isTv360Plus || normName)) {
      isDuplicate = true;
    }

    if (isDuplicate) {
      const existing = deduplicated.find((c) => {
        const cNorm = (c.cleanName || c.name || "").toLowerCase().replace(/\s+/g, "");
        if (isTv360Plus && cNorm === normName) return true;
        const cKey = `${(c.group || "").toLowerCase().trim()}::${cNorm}`;
        if (cKey === nameKey) return true;
        if (channel.id && c.id && String(c.id).toLowerCase().trim() === chId) return true;
        const cCanonical = getCanonicalStreamUrl(c.url);
        return cCanonical && canonicalUrl && cCanonical === canonicalUrl;
      });

      if (existing) {
        if (channel.url && existing.url !== channel.url) {
          existing.backupUrls = existing.backupUrls || [];
          if (!existing.backupUrls.includes(channel.url)) {
            existing.backupUrls.push(channel.url);
          }
        }
        if (Array.isArray(channel.urls)) {
          existing.urls = existing.urls || [existing.url];
          channel.urls.forEach((u: string) => {
            if (u && !existing.urls.includes(u)) {
              existing.urls.push(u);
            }
          });
        }
      }
      continue;
    }

    if (tv360Key) seenKeys.add(tv360Key);
    if (normName) seenKeys.add(nameKey);
    if (canonicalUrl && canonicalUrl.length > 20) seenUrls.add(canonicalUrl);
    if (chId) seenIds.add(chId);

    deduplicated.push({ ...channel });
  }

  return deduplicated;
}

async function fetchPlaylists(force = false): Promise<{ channels: any[]; categories: any[]; m3uText: string }> {
  // Check if cache is valid and contains no expired tokens
  if (!force && cachedData && Date.now() - cachedData.timestamp < CACHE_TTL_MS) {
    const hasExpired = cachedData.channels.some((c) => isTokenExpired(c.url));
    if (!hasExpired) {
      return cachedData;
    }
  }

  try {
    const fetchResult = await fetchGithubM3U(PRIMARY_HT_TV_URL);
    const text1 = fetchResult?.text || "";

    const primaryChannels = text1 ? parseM3USource(text1, "ht-tv") : [];

    // Deduplicate primaryChannels directly from PRIMARY_HT_TV_URL (nguồn duy nhất)
    const mergedChannels = deduplicateChannels(primaryChannels);

    const categoryOrder = [
      "VTV",
      "VTVCab",
      "HTV",
      "SCTV",
      "Địa Phương",
      "Sự Kiện TV360",
      "Thể Thao Quốc Tế",
      "Quốc Tế",
      "Phim Truyện",
      "Nghe Nhạc"
    ];

    const categories: any[] = [];
    const orderedChannels: any[] = [];
    let runningChannelNumber = 1;

    categoryOrder.forEach((catName) => {
      let chs = deduplicateChannels(mergedChannels.filter((c) => c.group === catName));
      if (chs.length > 0) {
        // Sort Thể Thao Quốc Tế, Quốc Tế, Phim Truyện, Địa Phương, and Sự Kiện TV360 (TV360+1..15)
        if (
          catName === "Thể Thao Quốc Tế" ||
          catName === "Quốc Tế" ||
          catName === "Phim Truyện" ||
          catName === "Địa Phương" ||
          catName === "Sự Kiện TV360"
        ) {
          chs = [...chs].sort((a, b) =>
            a.cleanName.localeCompare(b.cleanName, "vi", { sensitivity: "base", numeric: true })
          );
        }
        chs.forEach((c) => {
          c.channelNumber = runningChannelNumber++;
          if (!c.urls || c.urls.length === 0) {
            c.urls = [c.url];
          }
          if (!c.backupUrls) {
            c.backupUrls = c.urls.length > 1 ? c.urls.slice(1) : [];
          }
          orderedChannels.push(c);
        });
        categories.push({
          id: catName.toLowerCase().replace(/\s+/g, "_"),
          name: catName,
          channels: chs
        });
      }
    });

    // Build unified M3U playlist representation
    let m3uLines = ["#EXTM3U url-tvg=\"https://lichphatsong.io.vn/epg.xml\""];
    orderedChannels.forEach((ch) => {
      let extinf = `#EXTINF:-1 tvg-name="${ch.cleanName}" group-title="${ch.group}"`;
      if (ch.logo) extinf += ` tvg-logo="${ch.logo}"`;
      extinf += `, ${ch.name || ch.cleanName}`;
      m3uLines.push(extinf);

      if (ch.headers?.["User-Agent"]) {
        m3uLines.push(`#EXTVLCOPT:http-user-agent=${ch.headers["User-Agent"]}`);
      }
      if (ch.drm?.type && ch.drm.type !== "none") {
        m3uLines.push(`#KODIPROP:inputstream.adaptive.license_type=${ch.drm.type}`);
        if (ch.drm.licenseUrl) {
          m3uLines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.drm.licenseUrl}`);
        } else if (ch.drm.key) {
          m3uLines.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.drm.key}`);
        }
      }
      m3uLines.push(ch.url);
    });

    cachedData = {
      timestamp: Date.now(),
      channels: orderedChannels,
      categories,
      m3uText: m3uLines.join("\n")
    };

    // Lưu snapshot cache vào đĩa để dự phòng ngoại tuyến
    saveLocalCache(cachedData.m3uText, cachedData);

    return cachedData;
  } catch (err) {
    console.error("Error aggregating playlists:", err);
    if (cachedData) return cachedData;

    // Fallback sang cache trên đĩa nếu có
    const diskCachedM3u = loadLocalCache();
    if (diskCachedM3u) {
      const diskChannels = parseM3USource(diskCachedM3u, "ht-tv");
      return { channels: diskChannels, categories: [], m3uText: diskCachedM3u };
    }

    // Fallback sang snapshot mặc định (data/default-playlist.m3u)
    const snapshotText = loadLocalSnapshot();
    if (snapshotText) {
      const snapshotChannels = parseM3USource(snapshotText, "ht-tv");
      return { channels: snapshotChannels, categories: [], m3uText: snapshotText };
    }

    return { channels: [], categories: [], m3uText: "#EXTM3U\n" };
  }
}

// API endpoint returning structured JSON channels and categorized groups
app.get("/api/channels", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const data = await fetchPlaylists(forceRefresh);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load channels", details: err.message });
  }
});

// Endpoint returning VTV1 to VTV10 channels with live fresh tokens & actual HT TV card metadata
app.get("/api/vtv-channels", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const data = await fetchPlaylists(forceRefresh);
    const channels = data.channels || [];
    const vtvList = [];

    for (let i = 1; i <= 10; i++) {
      const vtvId = `vtv${i}`;
      const found = channels.find((c) => {
        const norm = normalizeForMatching(c.cleanName || c.name);
        return norm === vtvId || (c.id && normalizeForMatching(c.id) === vtvId);
      });

      const formattedNumber = String(i).padStart(2, "0");
      const cardName = `${formattedNumber}. VTV${i}`;
      const logoUrl = `https://raw.githubusercontent.com/hieu-TQS/LOGO-IPTV/main/${i}.png`;

      vtvList.push({
        id: vtvId,
        channelNumber: i,
        name: cardName,
        cleanName: `VTV${i}`,
        displayName: cardName,
        logo: found?.logo || logoUrl,
        url: found?.url || "",
        backupUrls: found?.backupUrls || [],
        headers: found?.headers || { "User-Agent": "Dalvik/2.1.0" },
        format: found?.format || "hls",
        drm: found?.drm
      });
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.json({ success: true, channels: vtvList });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load VTV channels", details: err.message });
  }
});

// Dedicated dynamic token refresh endpoint from primary playlist
app.get("/api/token-refresh", async (req, res) => {
  try {
    const channelName = ((req.query.channelName as string) || "").trim();
    const channelId = ((req.query.channelId as string) || "").trim();
    const currentUrl = ((req.query.url as string) || "").trim();

    const data = await fetchPlaylists(true); // Force real-time refresh from PRIMARY_HT_TV_URL
    const chs = data.channels || [];

    const getParamId = (u: string) => {
      if (!u) return "";
      const decoded = u.includes("%") ? decodeURIComponent(u) : u;
      const m = decoded.match(/[?&]id=([^&]+)/i);
      return m ? m[1].toLowerCase() : "";
    };

    const targetParamId = getParamId(currentUrl);
    const cleanTarget = channelName.toLowerCase().replace(/\s+/g, "");
    const normTarget = normalizeForMatching(channelName);

    const matched = chs.find((c) => {
      // 1. Match by channel name (e.g., "tv360+1", "ON Phim Việt")
      if (channelName) {
        const cleanClean = (c.cleanName || "").toLowerCase().replace(/\s+/g, "");
        const rawClean = (c.name || "").toLowerCase().replace(/\s+/g, "");
        if (cleanClean === cleanTarget || rawClean === cleanTarget) return true;
        const normClean = normalizeForMatching(c.cleanName || c.name || "");
        if (normTarget && normClean === normTarget) return true;
        if (cleanTarget.includes("phimviệt") || cleanTarget.includes("phimviet")) {
          if (cleanClean.includes("phimviệt") || cleanClean.includes("phimviet") || normClean.includes("phimviet")) return true;
        }
      }
      // 2. Match by exact stream ID param (e.g. ?id=175)
      if (targetParamId && getParamId(c.url) === targetParamId) return true;
      // 3. Match by channelId
      if (channelId && c.id === channelId) return true;
      return false;
    });

    if (matched) {
      // Ensure TV360+ channel has mandatory Dalvik headers
      const isTv360 = (matched.cleanName || "").toUpperCase().includes("TV360+") || (matched.url || "").includes("tv360.php");
      if (isTv360 && !matched.headers) {
        matched.headers = {
          "User-Agent": "Dalvik/2.1.0",
          "Referer": "https://tv360.vn/",
          "Origin": "https://tv360.vn"
        };
      }
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.json({
        success: true,
        channel: matched
      });
    }

    return res.json({ success: false, message: "Channel not found in playlist" });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to refresh token", details: err.message });
  }
});

// Proxy endpoint to fetch merged M3U playlist with fresh tokens and DRM
app.get("/api/m3u", async (req, res) => {
  try {
    const data = await fetchPlaylists();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.send(data.m3uText);
  } catch (err: any) {
    return res.status(502).json({
      error: "Unable to load M3U playlist from upstream servers",
      primary: PRIMARY_HT_TV_URL
    });
  }
});

// ClearKey / License URL resolver with 2s timeout
app.get("/api/clearkey", async (req, res) => {
  const licenseUrl = req.query.url as string;
  const isVietanhOrTv360 =
    licenseUrl?.includes("vietanhtv") ||
    licenseUrl?.includes("cleankey.php") ||
    licenseUrl?.includes("tv360") ||
    licenseUrl?.includes("viettel");
  const forcedUa = (req.query.ua as string) || (isVietanhOrTv360 ? "Dalvik/2.1.0" : (req.headers["user-agent"] as string) || "Mozilla/5.0");
  if (!licenseUrl) {
    return res.status(400).json({ error: "Missing license URL" });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout requirement

    const response = await fetch(licenseUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": forcedUa,
        "Accept": "*/*"
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ error: `License server responded with ${response.status}` });
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return res.json(data);
    }

    const text = await response.text();
    return res.setHeader("Content-Type", "text/plain").send(text);
  } catch (err: any) {
    return res.status(504).json({ error: "ClearKey license request timed out (2s) or failed", details: err.message });
  }
});

// Widevine DRM License Proxy (POST license challenge relay)
app.post("/api/widevine", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const licenseUrl = (req.query.url as string) || "https://tv.vietanhtv.top/mytv2/key.php";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(licenseUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": (req.headers["content-type"] as string) || "application/octet-stream",
        "User-Agent": "Dalvik/2.1.0",
        "Accept": "*/*",
      },
      body: req.body,
    });
    clearTimeout(timeoutId);

    const buffer = await response.arrayBuffer();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    return res.status(response.status).send(Buffer.from(buffer));
  } catch (err: any) {
    return res.status(502).json({ error: "Widevine license proxy error", details: err.message });
  }
});
app.options("/api/widevine", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(204).end();
});

// High-performance streaming proxy supporting multi-hop redirects (up to 6 hops), VLC User-Agent, and zero-copy pipe streaming
function handleStreamProxy(req: express.Request, res: express.Response) {
  const targetUrl = (req.query.url as string || "").trim();
  const customUa = req.query.ua as string;
  const customReferer = req.query.referer as string;
  const isOriginLivesport = targetUrl.toLowerCase().includes("livesport.io.vn") || targetUrl.toLowerCase().includes("livesport");
  const isOriginThirdPartyApi =
    targetUrl.toLowerCase().includes("freem3u.xyz") ||
    targetUrl.toLowerCase().includes("vmttv.dpdns.org") ||
    targetUrl.toLowerCase().includes("?vid=") ||
    targetUrl.toLowerCase().includes("&vid=") ||
    targetUrl.toLowerCase().includes("?id=") ||
    targetUrl.toLowerCase().includes("&id=");

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Always enable CORS headers immediately
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Transfer-Encoding");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  let activeUpstreamReq: http.ClientRequest | null = null;
  let activeUpstreamRes: http.IncomingMessage | null = null;
  let activeUpstreamSocket: any = null;
  let activePassThrough: PassThrough | null = null;
  let isClosed = false;
  let redirectCount = 0;
  let inactivityTimer: NodeJS.Timeout | null = null;
  const MAX_REDIRECTS = 6;

  // Cleanup Connection (Ngắt luồng tức thì):
  // Lắng nghe sự kiện ngắt kết nối từ client (close, aborted). Khi client ngắt kết nối,
  // proxy lập tức gọi destroy() đối với luồng upstream để giải phóng kết nối Xtream Codes,
  // ngăn chặn tình trạng kẹt kết nối dẫn đến lỗi Max Connections.
  const cleanupUpstream = () => {
    isClosed = true;
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (activePassThrough) {
      try {
        activePassThrough.unpipe();
      } catch (_) {}
      if (!activePassThrough.destroyed) {
        try {
          activePassThrough.destroy();
        } catch (_) {}
      }
      activePassThrough = null;
    }
    if (activeUpstreamRes) {
      try {
        activeUpstreamRes.unpipe();
      } catch (_) {}
      if (!activeUpstreamRes.destroyed) {
        try {
          activeUpstreamRes.destroy();
        } catch (_) {}
      }
      activeUpstreamRes = null;
    }
    if (activeUpstreamReq && !activeUpstreamReq.destroyed) {
      try {
        activeUpstreamReq.destroy();
      } catch (_) {}
      activeUpstreamReq = null;
    }
    if (activeUpstreamSocket && !activeUpstreamSocket.destroyed) {
      try {
        activeUpstreamSocket.destroy();
      } catch (_) {}
      activeUpstreamSocket = null;
    }
  };

  req.on("close", cleanupUpstream);
  req.on("aborted", cleanupUpstream);
  res.on("close", cleanupUpstream);

  async function executeHop(currentUrlStr: string) {
    if (isClosed) return;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrlStr);
    } catch (e: any) {
      if (!res.headersSent) {
        return res.status(400).json({ error: "Invalid target URL", url: currentUrlStr });
      }
      return;
    }

    const isHttps = parsedUrl.protocol === "https:";
    const origin = parsedUrl.origin;
    const lowerTarget = currentUrlStr.toLowerCase();

    // 1. Phân loại luồng kênh trong nước (VTV, HTV, VTVcab, TV360, FPTPlay, VieON)
    // TUYỆT ĐỐI BẢO TOÀN luồng xử lý kênh trong nước, không can thiệp logic riêng của nhóm này
    const isSpecialTv360 =
      lowerTarget.includes("id=175") ||
      lowerTarget.includes("id=32") ||
      lowerTarget.includes("id=31") ||
      lowerTarget.includes("348.m3u8") ||
      lowerTarget.includes("332.m3u8") ||
      lowerTarget.includes("/447/output") ||
      customUa === "Dalvik/2.1.0" ||
      (customReferer && customReferer.includes("tv360"));

    const isTV360 =
      isSpecialTv360 ||
      lowerTarget.includes("tv360") ||
      lowerTarget.includes("vietanhtv") ||
      lowerTarget.includes("viettel") ||
      lowerTarget.includes("cleankey");

    const isDomestic =
      isSpecialTv360 ||
      isTV360 ||
      lowerTarget.includes("fptplay") ||
      lowerTarget.includes("vieon") ||
      lowerTarget.includes("vtvgo") ||
      lowerTarget.includes("htv.com.vn");

    // 2. Nhận diện các domain/từ khóa của nhóm Thể Thao Quốc Tế & máy chủ Xtream Codes
    const isTargetInternationalSports =
      !isDomestic &&
      (req.query.isSports === "1" ||
        req.query.group === "sports" ||
        INTERNATIONAL_SPORTS_DOMAINS.some((domain) => lowerTarget.includes(domain)) ||
        (customUa && customUa.toLowerCase().includes("iptvsmarters")));

    const isSportsOrXtream =
      isTargetInternationalSports ||
      (!isDomestic &&
        (lowerTarget.includes("live.php") ||
          lowerTarget.includes("play_token") ||
          lowerTarget.includes("extension=ts") ||
          lowerTarget.includes(":80/play") ||
          lowerTarget.includes(":80/live") ||
          lowerTarget.includes(":8080/play") ||
          lowerTarget.includes(":8080/live") ||
          lowerTarget.includes("/hls/")));

    // Nhận diện luồng Xtream Codes / MPEG-TS trực tiếp (như zazaint.com, AD SPORTS PREMIUM 1, v.v.)
    const isXtreamCodesOrTs =
      lowerTarget.includes("zazaint.com") ||
      lowerTarget.includes("/live/") ||
      lowerTarget.includes("extension=ts") ||
      (lowerTarget.includes(".ts") && !isDomestic) ||
      lowerTarget.includes(":8080/") ||
      lowerTarget.includes(":80/") ||
      lowerTarget.includes("tharen1") ||
      lowerTarget.includes("terranovax1") ||
      lowerTarget.includes("ifiesta.net");

    // Nhận diện luồng MAG/Stalker portal (qua MAC address hoặc play_token)
    const isStalkerOrMag =
      lowerTarget.includes("mac=") ||
      lowerTarget.includes("play_token=") ||
      lowerTarget.includes("play_token") ||
      Boolean(req.query.mac) ||
      Boolean(req.query.play_token);

    const isLivesport =
      isOriginLivesport ||
      lowerTarget.includes("livesport.io.vn") ||
      lowerTarget.includes("livesport") ||
      req.query.isLivesport === "1";
    const isTv360Stream = isSpecialTv360 || isTV360 || lowerTarget.includes("tv360") || lowerTarget.includes("vietanhtv");
    const isThirdPartyApi = isOriginThirdPartyApi || isThirdPartyApiUrl(currentUrlStr);

    const isAngiangTvTarget =
      lowerTarget.includes("angiangtv.vn") ||
      lowerTarget.includes("kgtv1") ||
      (customReferer && customReferer.includes("angiangtv.vn"));

    let userAgent = "VLC/3.0.18 LibVLC/3.0.18";
    if (isAngiangTvTarget) {
      userAgent = CHROME_USER_AGENT;
    } else if (isStalkerOrMag) {
      userAgent = MAG_STALKER_USER_AGENT;
    } else if (isLivesport) {
      userAgent = "IPTVSmartersPro/3.1.5.1 (Linux; Android 10)";
    } else if (isXtreamCodesOrTs) {
      userAgent = customUa || "IPTVSmartersPlayer";
    } else if (isTv360Stream || isThirdPartyApi) {
      userAgent = customUa || "Dalvik/2.1.0";
    } else if (customUa) {
      userAgent = customUa;
    } else if (isTargetInternationalSports || isSportsOrXtream) {
      userAgent = "IPTVSmartersPlayer";
    }

    const requestHeaders: Record<string, string> = {
      "User-Agent": userAgent,
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "Connection": "keep-alive",
      "Icy-MetaData": "1",
    };

    if (isAngiangTvTarget) {
      requestHeaders["User-Agent"] = CHROME_USER_AGENT;
      requestHeaders["Referer"] = "https://angiangtv.vn/";
      requestHeaders["Origin"] = "https://angiangtv.vn";
    } else if (isStalkerOrMag) {
      // Chuẩn hóa User-Agent cho luồng MAG/Stalker tại Proxy theo chuẩn MAG200
      requestHeaders["User-Agent"] = MAG_STALKER_USER_AGENT;
      requestHeaders["Accept"] = "*/*";
      requestHeaders["Connection"] = "keep-alive";
      // Loại bỏ Referer và Origin trình duyệt để máy chủ Stalker/Ministra không từ chối kết nối
      delete requestHeaders["Referer"];
      delete requestHeaders["Origin"];
    } else if (isLivesport) {
      // Chuẩn hóa User-Agent cho luồng livesport (TSN 1-5, UNITE8 SPORT 1-2):
      // Dùng IPTVSmartersPro, tuyệt đối không gửi Referer/Origin để tránh server livesport chặn hotlink chuyển hướng sang spo.mp4
      requestHeaders["User-Agent"] = "IPTVSmartersPro/3.1.5.1 (Linux; Android 10)";
      requestHeaders["Accept"] = "*/*";
      requestHeaders["Connection"] = "keep-alive";
      delete requestHeaders["Referer"];
      delete requestHeaders["Origin"];
      delete requestHeaders["sec-fetch-dest"];
      delete requestHeaders["sec-fetch-mode"];
      delete requestHeaders["sec-fetch-site"];
    } else if (isXtreamCodesOrTs) {
      // Gán header User-Agent IPTVSmartersPlayer cho Xtream Codes / TS (như zazaint.com) thay vì default
      requestHeaders["User-Agent"] = customUa || "IPTVSmartersPlayer";
      requestHeaders["Accept"] = "*/*";
      requestHeaders["Connection"] = "keep-alive";
      if (customReferer) {
        requestHeaders["Referer"] = customReferer;
      }
      delete requestHeaders["Origin"];
    } else if (isTargetInternationalSports || isSportsOrXtream) {
      requestHeaders["User-Agent"] = customUa || "IPTVSmartersPlayer";
      requestHeaders["Accept"] = "*/*";
      requestHeaders["Connection"] = "keep-alive";
      if (customReferer) {
        requestHeaders["Referer"] = customReferer;
      }
      delete requestHeaders["Origin"];
    } else if (isTv360Stream || isThirdPartyApi) {
      requestHeaders["User-Agent"] = customUa || "Dalvik/2.1.0";
      requestHeaders["Referer"] = customReferer || "https://tv360.vn/";
      requestHeaders["Origin"] = "https://tv360.vn";
    } else if (lowerTarget.includes("fptplay")) {
      requestHeaders["Referer"] = "https://fptplay.vn/";
      requestHeaders["Origin"] = "https://fptplay.vn/";
    } else if (customReferer) {
      requestHeaders["Referer"] = customReferer;
    } else if (origin) {
      requestHeaders["Referer"] = origin + "/";
      requestHeaders["Origin"] = origin;
    }

    if (req.headers.range) {
      requestHeaders["Range"] = req.headers.range as string;
    }

    // Cấu hình HTTP Agent / HTTPS Agent với tham số rejectUnauthorized: false để bỏ qua lỗi chứng chỉ SSL giả mạo
    const sportsAgent = isTargetInternationalSports
      ? (isHttps ? sportsHttpsAgent : sportsHttpAgent)
      : undefined;

    const client = isHttps ? https : http;

    // Fast-Fail / Timeout ngắn cho khâu kết nối:
    // Đối với các request upstream lấy playlist (.m3u8, .mpd), đặt timeout kết nối ngắn (4 giây).
    // Nếu server nguồn không phản hồi header trong thời gian này, ngắt ngay và trả về HTTP 504 để frontend chủ động fallback.
    const isPlaylistReq = lowerTarget.includes(".m3u8") || lowerTarget.includes(".mpd");

    const connectTimeout = isLivesport
      ? 15000 // Tăng timeout kết nối manifest lên 15 giây để script stalkvip.php kịp phản hồi danh sách phát
      : (isPlaylistReq && isTv360Stream)
      ? 10000 // 10s cho TV360 playlist/MPD qua redirect CDN
      : (isPlaylistReq && isAngiangTvTarget)
      ? 10000 // 10s cho An Giang playlist
      : isPlaylistReq
      ? 4000 // Fast-Fail 4s cho playlist (.m3u8, .mpd) thông thường
      : isTargetInternationalSports || isSportsOrXtream || isTv360Stream
      ? 10000 // 10s cho Xtream Codes / Thể Thao Quốc Tế / TV360
      : lowerTarget.includes(".ts")
      ? (isAngiangTvTarget ? 30000 : 15000)
      : 8000;

    const clientReq = client.request(parsedUrl, {
      method: "GET",
      headers: requestHeaders,
      agent: sportsAgent,
      timeout: connectTimeout,
    }, async (upstreamRes) => {
      activeUpstreamRes = upstreamRes;
      if (isClosed) {
        cleanupUpstream();
        return;
      }

      try {
        clientReq.setTimeout(0);
        if (upstreamRes.socket) {
          upstreamRes.socket.setKeepAlive(false);
          try {
            upstreamRes.socket.setNoDelay(true);
          } catch (_) {}
        }
        res.setTimeout(0);
        req.setTimeout(0);
      } catch (_) {}

      const statusCode = upstreamRes.statusCode || 200;

      // Handle 301, 302, 303, 307, 308 redirects up to 6 hops
      if ([301, 302, 303, 307, 308].includes(statusCode) && upstreamRes.headers.location) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          cleanupUpstream();
          if (!res.headersSent) {
            return res.status(502).json({ error: `Too many redirects (>${MAX_REDIRECTS})` });
          }
          return;
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(upstreamRes.headers.location, currentUrlStr).href;
        } catch (err: any) {
          cleanupUpstream();
          if (!res.headersSent) {
            return res.status(502).json({ error: "Failed to resolve redirect Location header", location: upstreamRes.headers.location });
          }
          return;
        }

        // Bẫy anti-hotlink của livesport.io.vn: nếu server chuyển hướng đến spo.mp4
        if (nextUrl.includes("spo.mp4") || upstreamRes.headers.location.includes("spo.mp4")) {
          console.warn("[StreamProxy] Phát hiện bẫy anti-hotlink spo.mp4 từ livesport! Tự động đổi User-Agent IPTVSmartersPro và xóa Referer/Origin");
          requestHeaders["User-Agent"] = "IPTVSmartersPro/3.1.5.1 (Linux; Android 10)";
          delete requestHeaders["Referer"];
          delete requestHeaders["Origin"];
          delete requestHeaders["sec-fetch-dest"];
          delete requestHeaders["sec-fetch-mode"];
          delete requestHeaders["sec-fetch-site"];
          cleanupUpstream();
          return executeHop(currentUrlStr);
        }

        // Giải phóng kết nối hop hiện tại trước khi chuyển sang hop tiếp theo
        try {
          upstreamRes.destroy();
        } catch (_) {}
        try {
          clientReq.destroy();
        } catch (_) {}
        activeUpstreamRes = null;
        activeUpstreamReq = null;

        return executeHop(nextUrl);
      }

      const contentType = (upstreamRes.headers["content-type"] as string || "").toLowerCase();
      const lowerUrl = currentUrlStr.toLowerCase();

      // Check if upstream returned HTTP error status
      if (statusCode >= 400) {

        // Tự động thử fallback không kèm play_token nếu Stalker token bị vô hiệu hóa (502, 503, 401, 403, 404)
        if (isStalkerOrMag && currentUrlStr.includes("play_token=") && !currentUrlStr.includes("_no_tok_try")) {
          const fallbackNoToken = currentUrlStr
            .replace(/[?&]play_token=[^&#]*/gi, "")
            .replace(/&&+/g, "&")
            .replace(/\?&/, "?")
            .concat(currentUrlStr.includes("?") ? "&_no_tok_try=1" : "?_no_tok_try=1");

          cleanupUpstream();
          return executeHop(fallbackNoToken);
        }

        upstreamRes.resume();
        if (!res.headersSent) {
          return res.status(statusCode === 404 ? 404 : 502).json({
            error: `Upstream server responded with HTTP ${statusCode}`,
            url: currentUrlStr,
            contentType
          });
        }
        return;
      }

      const isLivesportUrl = isOriginLivesport || lowerUrl.includes("livesport.io.vn") || lowerUrl.includes("livesport");

      const isManifestOrMedia =
        lowerUrl.includes(".mpd") ||
        lowerUrl.includes(".m3u8") ||
        lowerUrl.includes("tv360.php") ||
        lowerUrl.includes("vieon.php") ||
        (isLivesportUrl && (lowerUrl.includes(".php") || lowerUrl.includes("id="))) ||
        lowerUrl.includes(".ts") ||
        lowerUrl.includes(".m4s") ||
        lowerUrl.includes(".mp4");

      // Reject HTML response when a media stream or manifest is requested (prevents XML parsing errors in Shaka / Hls.js)
      // Chú ý: TUYỆT ĐỐI không reject đối với nhóm Thể Thao Quốc Tế & livesport vì server upstream
      // có thể trả content-type: text/html cho cả playlist và chunks
      if (!isTargetInternationalSports && !isLivesportUrl && isManifestOrMedia && (contentType.includes("text/html") || contentType.includes("application/xhtml+xml"))) {
        upstreamRes.resume();
        if (!res.headersSent) {
          return res.status(502).json({
            error: "Upstream returned HTML error page instead of media manifest/stream",
            contentType,
            url: currentUrlStr
          });
        }
        return;
      }

      const isSegmentOrTs =
        lowerUrl.includes(".ts") ||
        lowerUrl.includes(".m4s") ||
        lowerUrl.includes("init.txt") ||
        lowerUrl.endsWith(".jpg") ||
        lowerUrl.includes(".jpg?") ||
        lowerUrl.includes("tokenized") ||
        contentType.includes("mp2t") ||
        contentType.includes("mpegts");

      // Check if it's an M3U8 playlist (bao gồm các link .php của livesport.io.vn và ViuTV Six / hidns.vip)
      const isViuTvManifest =
        lowerUrl.includes("viu6") ||
        lowerUrl.includes("cdn.qd.je") ||
        (lowerUrl.includes("hidns.vip") && !lowerUrl.includes("init.txt") && !lowerUrl.includes(".jpg"));

      const isM3U8 =
        !isSegmentOrTs && (
          isViuTvManifest ||
          lowerUrl.includes(".m3u8") ||
          (isLivesportUrl && (lowerUrl.includes(".php") || lowerUrl.includes("vip1.php") || lowerUrl.includes("id="))) ||
          (isTargetInternationalSports && (lowerUrl.includes("-got.htm") || lowerUrl.includes("usergen"))) ||
          contentType.includes("mpegurl") ||
          contentType.includes("application/x-mpegurl") ||
          contentType.includes("application/vnd.apple.mpegurl")
        );

      if (isM3U8 && !isSegmentOrTs) {
        let buffer = "";
        upstreamRes.setEncoding("utf-8");
        upstreamRes.on("data", (chunk) => {
          buffer += chunk;
        });

        upstreamRes.on("end", () => {
          if (isClosed) return;
          const trimmed = buffer.trim();
          // Verify it's not an HTML page disguised or error payload
          if (
            (isLivesportUrl && !trimmed.includes("#EXTM3U")) ||
            (!isTargetInternationalSports &&
             !isLivesportUrl &&
             !isViuTvManifest &&
             (trimmed.toLowerCase().includes("<html") ||
              trimmed.toLowerCase().includes("<!doctype html") ||
              (!trimmed.includes("#EXTM3U") && !trimmed.includes("#EXTINF"))))
          ) {
            if (!res.headersSent) {
              return res.status(502).json({
                error: isLivesportUrl ? "Nguồn phát trả về nội dung không hợp lệ (HTML/Empty)" : "Upstream returned invalid content (HTML/non-M3U8) for M3U8 playlist",
                url: currentUrlStr
              });
            }
            return;
          }

          res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, no-transform");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          res.setHeader("X-Accel-Buffering", "no");

          const isSports = isTargetInternationalSports || isSportsOrXtream;
          const isLivesportStream = isLivesportUrl || isLivesport;
          const isThirdPartyStream = isOriginThirdPartyApi || isThirdPartyApi;
          const isViuTv = lowerUrl.includes("viu6") || lowerUrl.includes("cdn.qd.je") || lowerUrl.includes("hidns.vip");
          const isAngiangStream =
            lowerUrl.includes("angiangtv.vn") ||
            lowerUrl.includes("kgtv1") ||
            (customReferer && customReferer.includes("angiangtv.vn"));
          const uaParam = isAngiangStream
            ? `&ua=${encodeURIComponent(CHROME_USER_AGENT)}`
            : (isSpecialTv360 || isThirdPartyStream)
            ? `&ua=Dalvik%2F2.1.0`
            : isLivesportStream
            ? `&ua=IPTVSmartersPro%2F3.1.5.1%20(Linux%3B%20Android%2010)`
            : isStalkerOrMag
            ? `&ua=${encodeURIComponent(MAG_STALKER_USER_AGENT)}`
            : isSports
            ? `&ua=IPTVSmartersPro%2F3.1.5.1%20(Linux%3B%20Android%2010)`
            : (customUa ? `&ua=${encodeURIComponent(customUa)}` : "");
          const effectiveReferer = isAngiangStream
            ? "https://angiangtv.vn/"
            : (isSpecialTv360 || isThirdPartyStream)
            ? "https://tv360.vn/"
            : isViuTv
            ? "https://cdn.qd.je/163189/viu6"
            : isLivesportStream
            ? ""
            : isSports
            ? (customReferer || "")
            : (customReferer || currentUrlStr);
          const refParam = effectiveReferer ? `&referer=${encodeURIComponent(effectiveReferer)}` : "";
          const sportsParam = isSports && !isLivesportStream ? "&isSports=1" : "";
          const livesportParam = isLivesportStream ? "&isLivesport=1" : "";
          const proxyParams = `${uaParam}${refParam}${sportsParam}${livesportParam}`;

          const rewritten = buffer.split("\n").map((line) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) return line;

            if (trimmedLine.startsWith("#")) {
              if (trimmedLine.includes('URI="')) {
                return trimmedLine.replace(/URI="([^"]+)"/g, (_match, uriVal) => {
                  try {
                    const resolvedUri = new URL(uriVal, currentUrlStr).href;
                    return `URI="/api/stream-proxy?url=${encodeURIComponent(resolvedUri)}${proxyParams}"`;
                  } catch {
                    return `URI="${uriVal}"`;
                  }
                });
              }
              return line;
            }

            try {
              const resolvedSegment = new URL(trimmedLine, currentUrlStr).href;
              return `/api/stream-proxy?url=${encodeURIComponent(resolvedSegment)}${proxyParams}`;
            } catch {
              return trimmedLine;
            }
          }).join("\n");

          return res.send(rewritten);
        });

        upstreamRes.on("error", (err) => {
          if (!res.headersSent) {
            res.status(502).json({ error: "M3U8 upstream error", message: err.message });
          }
        });
        return;
      }

      // MPD DASH Manifest
      const isMpd = lowerUrl.includes(".mpd") || contentType.includes("dash+xml");
      if (isMpd) {
        let mpdBuffer = "";
        upstreamRes.setEncoding("utf-8");
        upstreamRes.on("data", (chunk) => { mpdBuffer += chunk; });
        upstreamRes.on("end", () => {
          if (isClosed) return;
          const trimmed = mpdBuffer.trim();
          // Verify it's actually valid MPD XML and not an HTML error document
          if (
            trimmed.toLowerCase().includes("<html") ||
            trimmed.toLowerCase().includes("<!doctype html") ||
            !trimmed.includes("<MPD")
          ) {
            if (!res.headersSent) {
              return res.status(502).json({
                error: "Upstream returned HTML error page instead of valid DASH MPD manifest",
                url: currentUrlStr
              });
            }
            return;
          }

          res.setHeader("Content-Type", "application/dash+xml; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, no-transform");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          res.setHeader("X-Accel-Buffering", "no");

          const baseUrl = currentUrlStr.substring(0, currentUrlStr.lastIndexOf("/") + 1);
          let rewrittenMpd = mpdBuffer;

          // Rewrite any relative <BaseURL> into absolute URL
          if (rewrittenMpd.includes("<BaseURL>")) {
            rewrittenMpd = rewrittenMpd.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (match, rel) => {
              const trimmedRel = rel.trim();
              if (trimmedRel.startsWith("http://") || trimmedRel.startsWith("https://")) {
                return match;
              }
              try {
                const abs = new URL(trimmedRel, baseUrl).href;
                return `<BaseURL>${abs}</BaseURL>`;
              } catch {
                return match;
              }
            });
          } else if (baseUrl) {
            rewrittenMpd = rewrittenMpd.replace(/<MPD([^>]*)>/i, `<MPD$1>\n    <BaseURL>${baseUrl}</BaseURL>`);
          }

          return res.send(rewrittenMpd);
        });
        upstreamRes.on("error", (err) => {
          if (!res.headersSent) {
            res.status(502).json({ error: "MPD upstream error", message: err.message });
          }
        });
        return;
      }

      // Raw MPEG-TS Live Stream, Segment, or Binary Video Stream
      const isMpegTs =
        !isLivesportUrl && (
          contentType.includes("mp2t") ||
          contentType.includes("mpegts") ||
          lowerUrl.includes(".ts") ||
          lowerUrl.includes("tokenized") ||
          lowerUrl.includes("extension=ts") ||
          lowerUrl.includes("mac=") ||
          lowerUrl.includes("play_token=") ||
          lowerUrl.includes("live.php") ||
          lowerUrl.includes("ifiesta.net") ||
          lowerUrl.includes("zazaint.com") ||
          lowerUrl.includes("watchtivo") ||
          lowerUrl.includes("tivi-one-iptv") ||
          lowerUrl.includes("apolonbox") ||
          lowerUrl.includes("royallivetv") ||
          lowerUrl.includes("/hls/") ||
          lowerUrl.includes(":80/") ||
          lowerUrl.includes(":8080/") ||
          (isTargetInternationalSports && !isM3U8 && !isMpd)
        );

      if (isMpegTs) {
        res.setHeader("Content-Type", "video/mp2t");
      } else if (lowerUrl.includes("init.txt")) {
        res.setHeader("Content-Type", "video/mp4");
      } else if (lowerUrl.includes(".jpg") && (lowerUrl.includes("viu6") || lowerUrl.includes("hidns.vip"))) {
        res.setHeader("Content-Type", "video/mp4");
      } else if (contentType) {
        res.setHeader("Content-Type", contentType);
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
      }

      // Forward caching, zero-buffering and range headers
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, no-transform");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("X-Accel-Buffering", "no");

      if (upstreamRes.headers["content-range"]) {
        res.setHeader("Content-Range", upstreamRes.headers["content-range"] as string);
      }
      if (upstreamRes.headers["content-length"]) {
        res.setHeader("Content-Length", upstreamRes.headers["content-length"] as string);
      }

      res.status(statusCode);

      // Stream with instant zero-copy pipe and active connection cleanup
      upstreamRes.on("error", (err) => {
        cleanupUpstream();
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.end();
        }
      });

      upstreamRes.on("end", () => {
        cleanupUpstream();
      });

      upstreamRes.on("close", () => {
        cleanupUpstream();
      });

      res.on("error", () => {
        cleanupUpstream();
      });

      res.on("close", () => {
        cleanupUpstream();
      });

      res.on("finish", () => {
        cleanupUpstream();
      });

      // Bổ sung Data Inactivity Timeout: Nếu máy chủ upstream nhận kết nối nhưng bị treo dữ liệu (không gửi video quá 25s)
      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        const timeoutMs = 25000;
        inactivityTimer = setTimeout(() => {
          cleanupUpstream();
          if (!res.headersSent && !isClosed) {
            res.status(504).json({
              error: "Upstream stream data stalled (timeout)",
              url: currentUrlStr,
            });
          } else if (!res.writableEnded) {
            res.end();
          }
        }, timeoutMs);
      };

      if (isTargetInternationalSports || isSportsOrXtream) {
        resetInactivityTimer();
        upstreamRes.on("data", () => {
          resetInactivityTimer();
        });
      }

      // Fast-forward headers immediately
      try {
        res.flushHeaders();
      } catch (_) {}

      // Tắt Nagle's algorithm trên response socket để gửi chunk tức thì không giữ đệm TCP
      if (res.socket) {
        try {
          res.socket.setNoDelay(true);
        } catch (_) {}
      }

      // Zero-latency chunk forwarding: Bỏ qua mọi queue/buffer tích lũy dữ liệu trung gian, flush ngay khi có data chunk
      upstreamRes.on("data", (chunk: Buffer) => {
        if (!isClosed && !res.writableEnded) {
          const drained = res.write(chunk);
          if (typeof (res as any).flush === 'function') {
            try {
              (res as any).flush();
            } catch (_) {}
          }
          if (!drained) {
            upstreamRes.pause();
          }
        }
      });

      res.on("drain", () => {
        if (!isClosed && upstreamRes.readable) {
          upstreamRes.resume();
        }
      });

      upstreamRes.on("end", () => {
        cleanupUpstream();
        if (!res.writableEnded) {
          res.end();
        }
      });
    });

    activeUpstreamReq = clientReq;
    clientReq.on("socket", (sock) => {
      activeUpstreamSocket = sock;
      try {
        sock.setNoDelay(true);
      } catch (_) {}
      sock.on("close", () => {
        if (activeUpstreamSocket === sock) activeUpstreamSocket = null;
      });
    });

    if (isClosed) {
      cleanupUpstream();
      return;
    }

    clientReq.on("error", (err: any) => {
      cleanupUpstream();
      if (isClosed || req.destroyed) return;
      if (!res.headersSent) {
        res.status(502).json({ error: "Stream proxy upstream connection error", message: err.message });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    clientReq.on("timeout", () => {
      cleanupUpstream();
      if (!res.headersSent && !isClosed) {
        res.status(504).json({
          error: isPlaylistReq
            ? "Playlist (.m3u8) upstream connection timed out (Fast-Fail 4s)"
            : "Stream upstream connection timed out",
          url: currentUrlStr,
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    clientReq.end();
  }

  executeHop(targetUrl);
}

// Dynamic M3U8 Generator: Bọc luồng TS/MPEG-TS thành dynamic HLS manifest cho trình duyệt nếu cần
function handleM3u8Wrap(req: express.Request, res: express.Response) {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, no-transform");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const seq = Math.floor(Date.now() / 3000);
  const uaParam = req.query.ua ? `&ua=${encodeURIComponent(req.query.ua as string)}` : "";
  const proxyChunkUrl = `/api/stream-proxy?url=${encodeURIComponent(targetUrl)}${uaParam}`;

  const manifest = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    "#EXTINF:3.000,",
    `${proxyChunkUrl}&chunk=${seq}`,
    "#EXTINF:3.000,",
    `${proxyChunkUrl}&chunk=${seq + 1}`,
  ].join("\n");

  return res.send(manifest);
}

// Endpoints for Stream Proxy, CORS Proxy, and Dynamic M3U8 Generator
app.get("/api/stream-proxy", handleStreamProxy);
app.get("/api/proxy", handleStreamProxy);
app.get("/api/m3u8-wrap", handleM3u8Wrap);

// Gemini Voice AI Channel Matching Endpoint
app.post("/api/gemini/voice-search", async (req, res) => {
  try {
    const { prompt, channels } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid prompt" });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
    if (!apiKey) {
      return res.json({ matchedId: null, reason: "No server-side GEMINI_API_KEY" });
    }

    const ai = new GoogleGenAI({ apiKey });
    const channelContext = Array.isArray(channels)
      ? channels.map((c: any) => ({
          id: c.id,
          name: c.cleanName || c.name,
          category: c.group || c.category || "",
        })).slice(0, 150)
      : [];

    const systemInstruction = `
Bạn là trợ lý ảo TV thông minh điều khiển ứng dụng HT-TV.
Người dùng sẽ ra lệnh bằng giọng nói tiếng Việt.

Nhiệm vụ của bạn có 2 loại:
1. Tìm kênh: Trả về matchedId của kênh phù hợp nhất (ví dụ: "bật VTV1", "mở đá bóng").
2. Điều khiển hệ thống: Trả về hành động tương ứng trong trường 'action'.
   - "tăng âm lượng", "to lên", "nghe to hơn" -> action: 'volume_up'
   - "giảm âm lượng", "nhỏ lại", "nghe nhỏ hơn" -> action: 'volume_down'
   - "phóng to", "thu nhỏ", "toàn màn hình", "thoát toàn màn hình" -> action: 'zoom_toggle'

Trả về định dạng JSON thuần túy theo Schema: {"matchedId": string | null, "action": string | null, "reason": string}.
Nếu không tìm thấy kênh và không phải lệnh điều khiển, trả matchedId và action là null.
`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Danh sách kênh hiện có: ${JSON.stringify(channelContext)}\nNgười dùng nói: "${prompt}"`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text || "{}";
    const data = JSON.parse(responseText);
    return res.json({
      matchedId: data.matchedId || null,
      action: data.action || null,
      reason: data.reason || "",
    });
  } catch (error: any) {
    console.warn("[Gemini Voice API] Warning:", error?.message || error);
    const p = (req.body?.prompt || "").toLowerCase();
    let action: string | null = null;
    if (p.includes("tăng âm") || p.includes("to lên") || p.includes("nghe to") || p.includes("volume up")) {
      action = "volume_up";
    } else if (p.includes("giảm âm") || p.includes("nhỏ lại") || p.includes("nghe nhỏ") || p.includes("volume down")) {
      action = "volume_down";
    } else if (p.includes("phóng to") || p.includes("thu nhỏ") || p.includes("toàn màn hình") || p.includes("fullscreen")) {
      action = "zoom_toggle";
    }
    return res.json({ matchedId: null, action, reason: action ? "Fallback Action" : "Gemini Error" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "HT TV", timestamp: Date.now() });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`HT TV server running at http://0.0.0.0:${PORT}`);

    // Periodic background token refresh every 90 seconds to keep tokens perpetually valid
    setInterval(() => {
      fetchPlaylists(true).catch((err) => {
        console.warn("[Background Token Refresh] Warning:", err.message);
      });
    }, 90 * 1000);
  });

  server.on("error", (err: any) => {
    console.error(`[HT TV Server] Error on primary port ${PORT}:`, err);
  });

  // In production deployment, if PORT is not 3000, also bind to port 3000 as secondary listener if available
  if (isCloudRunProd && PORT !== 3000) {
    try {
      const fallbackServer = app.listen(3000, "0.0.0.0", () => {
        console.log(`HT TV secondary listener active on port 3000`);
      });
      fallbackServer.on("error", () => {
        // Silently ignore if port 3000 is occupied
      });
    } catch {
      // Silently ignore
    }
  }
}

startServer();
