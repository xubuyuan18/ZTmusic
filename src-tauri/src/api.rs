use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, COOKIE, USER_AGENT};
use serde_json::{json, Value};
use tauri::State;

use crate::{AppState, NcmRequest, NcmResponse, APP_USER_AGENT};

/// 允许代理的目标 API Host 白名单（精确匹配），防止 SSRF
const ALLOWED_HOSTS: &[&str] = &[
    "music.xubuyuan.top",
    "music.163.com",
    "interface.music.163.com",
    "interface3.music.163.com",
];

/// 精确匹配 host（不做后缀匹配，避免 `attacker-music.163.com` 这类后缀绕过）
fn is_allowed_host(host: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|allowed| host == *allowed)
}

/// 登录态请求可能按上游 API 约定把 cookie 放在 query/form 中，因此必须强制 HTTPS。
fn ensure_secure_cookie_transport(url: &reqwest::Url, cookie: Option<&str>) -> Result<(), String> {
    if cookie.filter(|cookie| !cookie.is_empty()).is_some() && url.scheme() != "https" {
        return Err("Authenticated API requests require HTTPS".to_string());
    }
    Ok(())
}

/// POST/GET 代理：将前端请求转发到 Netease API，并回传 cookie 变更。
#[tauri::command]
pub async fn ncm_request(
    state: State<'_, AppState>,
    request: NcmRequest,
) -> Result<NcmResponse, String> {
    let mut url = build_api_url(&request.base, &request.endpoint)?;

    // SSRF 防护：仅允许白名单内的 Host
    if let Some(host) = url.host_str() {
        if !is_allowed_host(host) {
            return Err(format!("API host not allowed: {host}"));
        }
    }
    let method = request.method.to_uppercase();
    let cookie = request.cookie.as_deref().filter(|cookie| !cookie.is_empty());
    ensure_secure_cookie_transport(&url, cookie)?;

    let mut builder = match method.as_str() {
        "GET" => {
            append_query_pairs(&mut url, &request.params, cookie);
            state.client.get(url)
        }
        "POST" => state.client.post(url),
        _ => return Err(format!("Unsupported API method: {method}")),
    };

    builder = builder.header(USER_AGENT, APP_USER_AGENT);
    builder = builder.header("Referer", "https://music.163.com/");

    if let Some(cookie) = cookie {
        let value =
            HeaderValue::from_str(cookie).map_err(|error| format!("Invalid cookie: {error}"))?;
        builder = builder.header(COOKIE, value);
    }

    if method == "POST" {
        let form_body = value_to_form_pairs(&request.body.unwrap_or_else(|| json!({})), cookie);
        builder = builder
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&form_body);
    }

    let response = builder
        .send()
        .await
        // reqwest 错误默认可能携带完整 URL；URL 中可能有 cookie query，必须移除。
        .map_err(|error| format!("API request failed: {}", error.without_url()))?;
    let status = response.status();
    let cookie = collect_set_cookie(response.headers());
    let data = response.json::<Value>().await.unwrap_or_else(
        |_| json!({ "code": status.as_u16(), "message": format!("API error: {status}") }),
    );

    if !status.is_success() && !request.allow_error_body.unwrap_or(false) {
        return Err(format!("API error: {status} {data}"));
    }

    Ok(NcmResponse { data, cookie })
}

// ── helpers ────────────────────────────────────────────────

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => value.to_string(),
    }
}

fn build_api_url(base: &str, endpoint: &str) -> Result<reqwest::Url, String> {
    let base = base.trim_end_matches('/');
    let endpoint = endpoint.trim_start_matches('/');
    let url = reqwest::Url::parse(&format!("{base}/{endpoint}"))
        .map_err(|error| format!("Invalid API url: {error}"))?;

    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!("Unsupported API url scheme: {scheme}")),
    }
}

fn append_query_pairs(url: &mut reqwest::Url, params: &Value, cookie: Option<&str>) {
    if let Some(map) = params.as_object() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in map {
            if value.is_null() {
                continue;
            }
            pairs.append_pair(key, &value_to_string(value));
        }
        // NeteaseCloudMusicApi 兼容层依赖 cookie 参数；传输层已在上方强制 HTTPS。
        if let Some(cookie) = cookie {
            pairs.append_pair("cookie", cookie);
        }
    }
}

fn value_to_form_pairs(body: &Value, cookie: Option<&str>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    if let Some(map) = body.as_object() {
        for (key, value) in map {
            if value.is_null() {
                continue;
            }
            pairs.push((key.clone(), value_to_string(value)));
        }
    }
    if let Some(cookie) = cookie {
        pairs.push(("cookie".to_string(), cookie.to_string()));
    }
    pairs
}

fn collect_set_cookie(headers: &HeaderMap) -> String {
    headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::SET_COOKIE;

    #[test]
    fn collect_set_cookie_keeps_all_cookie_pairs() {
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("MUSIC_U=token; Path=/; HttpOnly"),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("__csrf=csrf; Max-Age=3600; SameSite=Lax"),
        );
        headers.append(SET_COOKIE, HeaderValue::from_static("NMTID=nmt"));

        assert_eq!(collect_set_cookie(&headers), "MUSIC_U=token; __csrf=csrf; NMTID=nmt");
    }

    #[test]
    fn collect_set_cookie_ignores_empty_and_invalid_values() {
        let mut headers = HeaderMap::new();
        headers.append(SET_COOKIE, HeaderValue::from_static(" ; Path=/"));
        headers.append(SET_COOKIE, HeaderValue::from_bytes(&[0xff]).unwrap());

        assert_eq!(collect_set_cookie(&headers), "");
    }

    #[test]
    fn authenticated_requests_require_https() {
        let secure = reqwest::Url::parse("https://music.xubuyuan.top/song/url").unwrap();
        let insecure = reqwest::Url::parse("http://music.xubuyuan.top/song/url").unwrap();

        assert!(ensure_secure_cookie_transport(&secure, Some("MUSIC_U=token")).is_ok());
        assert!(ensure_secure_cookie_transport(&insecure, None).is_ok());
        assert!(ensure_secure_cookie_transport(&insecure, Some("MUSIC_U=token")).is_err());
    }
}
