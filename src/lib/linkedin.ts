import crypto from "node:crypto";

const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202609";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is not configured");
  return value;
}

function key() {
  return crypto.createHash("sha256").update(required("LINKEDIN_TOKEN_ENCRYPTION_KEY")).digest();
}

export function encryptLinkedInToken(token: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptLinkedInToken(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid LinkedIn token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function linkedInAuthUrl(params: { state: string; redirectUri: string }) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: required("LINKEDIN_CLIENT_ID"),
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: "openid profile email w_member_social",
  });
  return "https://www.linkedin.com/oauth/v2/authorization?" + query.toString();
}

export async function exchangeLinkedInCode(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: required("LINKEDIN_CLIENT_ID"),
    client_secret: required("LINKEDIN_CLIENT_SECRET"),
  });
  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "LinkedIn OAuth token exchange failed");
  return data as { access_token: string; expires_in?: number; scope?: string };
}

export async function getLinkedInUserInfo(accessToken: string) {
  const response = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: "Bearer " + accessToken },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.sub) throw new Error(data.message || "LinkedIn userinfo failed");
  return data as { sub: string; name?: string; email?: string; picture?: string };
}

export async function createLinkedInPost(accessToken: string, author: string, commentary: string) {
  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Linkedin-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.errorDetail || "LinkedIn post failed");
  return { id: response.headers.get("x-restli-id") || data.id || null, raw: data };
}


export async function getLinkedInMemberPostAnalytics(accessToken: string, postUrn: string) {
  const params = new URLSearchParams({
    q: "entity",
    entity: postUrn,
    queryType: "ALL",
    aggregation: "TOTAL",
    timeRange: "(timeGranularityType:DAY)",
  });
  const response = await fetch(
    "https://api.linkedin.com/rest/memberCreatorPostAnalytics?" + params.toString(),
    {
      headers: {
        Authorization: "Bearer " + accessToken,
        "Linkedin-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.errorDetail || "LinkedIn analytics failed");
  return data;
}

export async function createLinkedInVideoPost(
  accessToken: string,
  author: string,
  commentary: string,
  video: Uint8Array,
) {
  const initResponse = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Linkedin-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: author,
        fileSizeBytes: video.byteLength,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const initData = await initResponse.json().catch(() => ({}));
  if (!initResponse.ok) {
    throw new Error(initData.message || initData.errorDetail || "LinkedIn video initialize upload failed");
  }

  const value = initData?.value;
  const videoUrn = String(value?.video || "");
  const instructions = Array.isArray(value?.uploadInstructions) ? value.uploadInstructions : [];
  if (!videoUrn || !instructions.length) {
    throw new Error("LinkedIn video upload instructionsが返りませんでした。");
  }

  const etags: string[] = [];
  for (const instruction of instructions) {
    const firstByte = Number(instruction.firstByte);
    const lastByte = Number(instruction.lastByte);
    const chunk = video.slice(firstByte, lastByte + 1);
    const uploadResponse = await fetch(String(instruction.uploadUrl), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      signal: AbortSignal.timeout(120_000),
    });
    if (!uploadResponse.ok) {
      throw new Error(`LinkedIn video upload failed: HTTP ${uploadResponse.status}`);
    }
    const etag = uploadResponse.headers.get("etag");
    if (!etag) throw new Error("LinkedIn video uploadのETagが返りませんでした。");
    etags.push(etag);
  }

  const finalizeResponse = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Linkedin-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      finalizeUploadRequest: {
        video: videoUrn,
        uploadToken: String(value?.uploadToken || ""),
        uploadedPartIds: etags,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const finalizeData = await finalizeResponse.json().catch(() => ({}));
  if (!finalizeResponse.ok) {
    throw new Error(finalizeData.message || finalizeData.errorDetail || "LinkedIn video finalize failed");
  }

  let videoStatus = "PROCESSING";
  for (let attempt = 0; attempt < 20 && videoStatus !== "AVAILABLE"; attempt++) {
    const statusResponse = await fetch(
      "https://api.linkedin.com/rest/videos/" + encodeURIComponent(videoUrn),
      {
        headers: {
          Authorization: "Bearer " + accessToken,
          "Linkedin-Version": LINKEDIN_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    const statusData = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      throw new Error(statusData.message || statusData.errorDetail || "LinkedIn video status failed");
    }
    videoStatus = String(statusData?.status || "");
    if (videoStatus === "PROCESSING_FAILED") {
      throw new Error(statusData?.processingFailureReason || "LinkedIn video processing failed");
    }
    if (videoStatus !== "AVAILABLE") {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (videoStatus !== "AVAILABLE") {
    throw new Error("LinkedIn video processingがタイムアウトしました。");
  }

  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Linkedin-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author,
      commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title: "AI acquisition creative", id: videoUrn } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.errorDetail || "LinkedIn video post failed");
  return {
    id: response.headers.get("x-restli-id") || data.id || null,
    videoUrn,
    raw: data,
  };
}
