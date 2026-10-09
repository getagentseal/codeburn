//! One lookup for the tray menu and the webview that fills it.
//!
//! Keys are the English sentence, the same contract as `Localization.swift`. A missing
//! zh-Hans entry falls back to that sentence. The catalogs are embedded so the MSI does
//! not need the mac bundle beside it.
//!
//! `system` follows the Windows UI language list (`GetUserPreferredUILanguages`), not
//! `GetUserDefaultLocaleName`, which telemetry already uses for a country code.
//! Shipped UI languages match the desktop app: en, fr, ja, ko, zh-Hans (`zh-CN`) and
//! zh-Hant (`zh-TW`, `zh-HK`).

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde_json::Value;

const EN_JSON: &str = include_str!("../locales/en.json");
const FR_JSON: &str = include_str!("../locales/fr.json");
const JA_JSON: &str = include_str!("../locales/ja.json");
const KO_JSON: &str = include_str!("../locales/ko.json");
const ZH_HANS_JSON: &str = include_str!("../locales/zh-Hans.json");
const ZH_HANT_JSON: &str = include_str!("../locales/zh-Hant.json");

struct Catalogs {
    tables: BTreeMap<&'static str, BTreeMap<String, String>>,
}

fn catalogs() -> &'static Catalogs {
    static CATALOGS: OnceLock<Catalogs> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        let mut tables = BTreeMap::new();
        tables.insert("en", parse_catalog(EN_JSON, "en"));
        tables.insert("fr", parse_catalog(FR_JSON, "fr"));
        tables.insert("ja", parse_catalog(JA_JSON, "ja"));
        tables.insert("ko", parse_catalog(KO_JSON, "ko"));
        tables.insert("zh-Hans", parse_catalog(ZH_HANS_JSON, "zh-Hans"));
        tables.insert("zh-Hant", parse_catalog(ZH_HANT_JSON, "zh-Hant"));
        Catalogs { tables }
    })
}

fn parse_catalog(raw: &str, name: &str) -> BTreeMap<String, String> {
    serde_json::from_str(raw)
        .unwrap_or_else(|err| panic!("{name} locale catalog is not a string map: {err}"))
}

fn catalog_for(locale: &str) -> &'static BTreeMap<String, String> {
    let catalogs = catalogs();
    catalogs
        .tables
        .get(locale)
        .or_else(|| catalogs.tables.get("en"))
        .expect("en catalog")
}

/// The sentence for `key` in the resolved language. An unknown key comes back unchanged,
/// which is also what a missing translation does.
pub fn lookup(key: &str) -> String {
    translate(&resolved_language(), key)
}

fn translate(locale: &str, key: &str) -> String {
    catalog_for(locale)
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.to_owned())
}

/// The map the webview caches. Substitution stays here; the page only looks sentences up.
pub fn active_catalog() -> BTreeMap<String, String> {
    catalog_for(&resolved_language()).clone()
}

/// Localized `key`, with `%@`, `%lld`, `%1$@` and `%%` filled from `args`.
pub fn format_message(key: &str, args: &[Value]) -> String {
    fill(&lookup(key), args)
}

/// Shared config preference; only a missing language follows the system.
pub fn normalize_preference(value: Option<&str>) -> &'static str {
    match value {
        Some("zh-CN") | Some("zh-Hans") => "zh-Hans",
        Some("zh-TW") | Some("zh-HK") | Some("zh-Hant") => "zh-Hant",
        Some("en") => "en",
        Some("fr") => "fr",
        Some("ja") => "ja",
        Some("ko") => "ko",
        Some(_) => "en",
        None => "system",
    }
}

/// `en` and `zh-Hans` win over the machine. `system` (and any unknown preference) follows
/// the first UI language. The list is an argument so tests never call Win32.
pub fn resolve_language<'a>(
    preference: &str,
    ui_languages: impl IntoIterator<Item = &'a str>,
) -> &'static str {
    match preference {
        "en" => "en",
        "fr" => "fr",
        "ja" => "ja",
        "ko" => "ko",
        "zh-Hans" => "zh-Hans",
        "zh-Hant" => "zh-Hant",
        _ => match first_ui_language(ui_languages) {
            Some(tag) if is_traditional_chinese(tag) => "zh-Hant",
            Some(tag) if is_simplified_chinese(tag) => "zh-Hans",
            Some(tag) if is_language(tag, "fr") => "fr",
            Some(tag) if is_language(tag, "ja") => "ja",
            Some(tag) if is_language(tag, "ko") => "ko",
            _ => "en",
        },
    }
}

fn first_ui_language<'a>(ui_languages: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    ui_languages
        .into_iter()
        .map(str::trim)
        .find(|tag| !tag.is_empty())
}

fn normalized_tag(tag: &str) -> String {
    let head = tag.split(['.', '@']).next().unwrap_or(tag);
    head.replace('_', "-").to_ascii_lowercase()
}

fn is_simplified_chinese(tag: &str) -> bool {
    let normalized = normalized_tag(tag);
    language_is(&normalized, "zh-hans")
        || language_is(&normalized, "zh-cn")
        || language_is(&normalized, "zh-sg")
}

fn is_traditional_chinese(tag: &str) -> bool {
    let normalized = normalized_tag(tag);
    language_is(&normalized, "zh-hant")
        || language_is(&normalized, "zh-tw")
        || language_is(&normalized, "zh-hk")
        || language_is(&normalized, "zh-mo")
}

fn is_language(tag: &str, want: &str) -> bool {
    let normalized = normalized_tag(tag);
    language_is(&normalized, want)
}

/// The raw `language` value in config.json, or an empty string when it is absent.
/// A change here is what a desktop-app language switch looks like to the tray.
pub fn stored_language_key() -> String {
    crate::config::read()
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

#[derive(serde::Serialize)]
pub struct LanguageState {
    /// The desktop app's config value: `system` when the key is absent.
    pub choice: String,
    /// The catalog this process should render.
    pub locale: String,
}

pub fn language_state() -> LanguageState {
    let stored = stored_language_key();
    let choice = match stored.as_str() {
        "" => "system",
        "zh-Hans" | "zh-CN" => "zh-CN",
        "zh-Hant" | "zh-TW" | "zh-HK" => "zh-TW",
        "en" | "fr" | "ja" | "ko" => stored.as_str(),
        _ => "system",
    };
    LanguageState {
        choice: choice.to_owned(),
        locale: resolved_language(),
    }
}

fn language_is(tag: &str, want: &str) -> bool {
    tag == want || tag.starts_with(&format!("{want}-"))
}

fn language_preference() -> &'static str {
    let stored = crate::config::read();
    normalize_preference(stored.get("language").and_then(Value::as_str))
}

fn resolved_language() -> String {
    #[cfg(test)]
    if let Some(locale) = forced_locale() {
        return locale.to_owned();
    }
    let languages = host_ui_languages();
    resolve_language(language_preference(), languages.iter().map(String::as_str)).to_owned()
}

#[derive(Clone, Copy)]
enum TokenKind {
    Percent,
    Text,
    Integer,
}

struct Token {
    len: usize,
    kind: TokenKind,
    /// Set when the placeholder names its argument (`%1$@`, `%2$lld`).
    index: Option<usize>,
}

fn take_token(source: &str) -> Option<Token> {
    if source.starts_with("%%") {
        return Some(Token {
            len: 2,
            kind: TokenKind::Percent,
            index: None,
        });
    }
    let after = source.get(1..)?;
    let (head, index) = positional_prefix(after);
    let rest = after.get(head..)?;
    if let Some(kind) = token_kind(rest) {
        let kind_len = match kind {
            TokenKind::Integer => 3,
            TokenKind::Text => 1,
            TokenKind::Percent => return None,
        };
        return Some(Token {
            len: 1 + head + kind_len,
            kind,
            index,
        });
    }
    None
}

fn positional_prefix(after: &str) -> (usize, Option<usize>) {
    let digits = after
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits > 0 && after[digits..].starts_with('$') {
        let index = after[..digits]
            .parse::<usize>()
            .ok()
            .filter(|index| *index > 0);
        (digits + 1, index.map(|index| index - 1))
    } else {
        (0, None)
    }
}

fn token_kind(rest: &str) -> Option<TokenKind> {
    if rest.starts_with("lld") {
        Some(TokenKind::Integer)
    } else if rest.starts_with('@') {
        Some(TokenKind::Text)
    } else {
        None
    }
}

#[cfg(test)]
fn placeholder_tokens(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find('%') {
        rest = &rest[pos..];
        match take_token(rest) {
            Some(token) => {
                tokens.push(&rest[..token.len]);
                rest = &rest[token.len..];
            }
            None => rest = &rest[1..],
        }
    }
    tokens
}

fn fill(template: &str, args: &[Value]) -> String {
    let mut out = String::new();
    let mut sequential = 0usize;
    let mut rest = template;
    while let Some(pos) = rest.find('%') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        match take_token(rest) {
            Some(token) => {
                match token.kind {
                    TokenKind::Percent => out.push('%'),
                    TokenKind::Text | TokenKind::Integer => {
                        let index = token.index.unwrap_or_else(|| {
                            let current = sequential;
                            sequential += 1;
                            current
                        });
                        out.push_str(&render_arg(token.kind, args.get(index)));
                    }
                }
                rest = &rest[token.len..];
            }
            None => {
                out.push('%');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn render_arg(kind: TokenKind, value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match kind {
        TokenKind::Integer => integer_text(value),
        TokenKind::Text => match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            other => other.to_string().trim_matches('"').to_owned(),
        },
        TokenKind::Percent => "%".to_owned(),
    }
}

fn integer_text(value: &Value) -> String {
    if let Some(number) = value.as_i64() {
        return number.to_string();
    }
    if let Some(number) = value.as_u64() {
        return number.to_string();
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() && number.fract() == 0.0 {
            return format!("{}", number as i64);
        }
        return number.to_string();
    }
    value.as_str().unwrap_or("").to_owned()
}

#[cfg(target_os = "windows")]
fn host_ui_languages() -> Vec<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};

    let mut count = 0u32;
    let mut needed = 0u32;
    // A null buffer asks for the size. `needed` stays 0 when the list cannot be read.
    let _probe = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut needed,
        )
    };
    if needed == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u16; needed as usize];
    let ok = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            buffer.as_mut_ptr(),
            &mut needed,
        )
    };
    if ok == 0 {
        return Vec::new();
    }
    let len = (needed as usize).min(buffer.len());
    decode_ui_languages(&buffer[..len])
}

#[cfg(not(target_os = "windows"))]
fn host_ui_languages() -> Vec<String> {
    // Same order as `telemetry::user_country`: the first non-empty locale wins, so
    // `cargo test` resolves `system` without Win32.
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok())
        .filter(|locale| !locale.is_empty())
        .into_iter()
        .collect()
}

#[cfg(target_os = "windows")]
fn decode_ui_languages(units: &[u16]) -> Vec<String> {
    let mut languages = Vec::new();
    let mut start = 0;
    for (index, unit) in units.iter().enumerate() {
        if *unit != 0 {
            continue;
        }
        if index == start {
            break;
        }
        languages.push(String::from_utf16_lossy(&units[start..index]));
        start = index + 1;
    }
    languages
}

#[cfg(test)]
thread_local! {
    static FORCED_LOCALE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn forced_locale() -> Option<&'static str> {
    FORCED_LOCALE.with(|cell| cell.get())
}

/// Pins `lookup` for one test. Dropping it restores the real preference and UI list.
#[cfg(test)]
pub(crate) struct LocaleLock;

#[cfg(test)]
impl LocaleLock {
    pub(crate) fn acquire(locale: &'static str) -> Self {
        FORCED_LOCALE.with(|cell| cell.set(Some(locale)));
        Self
    }
}

#[cfg(test)]
impl Drop for LocaleLock {
    fn drop(&mut self) {
        FORCED_LOCALE.with(|cell| cell.set(None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_share_every_key_and_placeholder() {
        let tables = &catalogs().tables;
        let en = tables.get("en").expect("en");
        for (name, table) in tables {
            assert_eq!(
                en.keys().cloned().collect::<Vec<_>>(),
                table.keys().cloned().collect::<Vec<_>>(),
                "en and {name} must list the same keys"
            );
            for (key, english) in en {
                let translated = table.get(key).unwrap_or_else(|| panic!("{name} is missing {key}"));
                assert_eq!(
                    placeholder_tokens(english),
                    placeholder_tokens(translated),
                    "{name} {key}"
                );
            }
        }
    }

    #[test]
    fn placeholder_order_covers_escaped_percent_and_positional_tokens() {
        assert_eq!(
            placeholder_tokens("100%% · %1$@ · %lld · %2$lld · %@"),
            vec!["%%", "%1$@", "%lld", "%2$lld", "%@"]
        );
    }

    #[test]
    fn lookup_under_zh_hans_uses_the_glossary_and_returns_an_unknown_key() {
        let _lock = LocaleLock::acquire("zh-Hans");
        assert_eq!(lookup("Quit CodeBurn"), "退出 CodeBurn");
        assert_eq!(lookup("System"), "跟随系统");
        assert_eq!(lookup("not a catalog key"), "not a catalog key");
    }

    #[test]
    fn an_explicit_language_beats_the_ui_list_and_system_follows_it() {
        assert_eq!(resolve_language("en", ["zh-CN", "en-US"]), "en");
        assert_eq!(resolve_language("zh-Hans", ["en-US"]), "zh-Hans");
        assert_eq!(resolve_language("system", ["zh-CN"]), "zh-Hans");
        assert_eq!(resolve_language("system", ["zh-Hans"]), "zh-Hans");
        assert_eq!(resolve_language("system", ["zh-SG"]), "zh-Hans");
        assert_eq!(resolve_language("system", ["zh_CN.UTF-8"]), "zh-Hans");
        assert_eq!(resolve_language("system", ["zh-TW"]), "zh-Hant");
        assert_eq!(resolve_language("system", ["zh-HK"]), "zh-Hant");
        assert_eq!(resolve_language("system", ["zh-Hant"]), "zh-Hant");
        assert_eq!(resolve_language("zh-Hant", ["en-US"]), "zh-Hant");
        assert_eq!(resolve_language("system", ["fr-FR"]), "fr");
        assert_eq!(resolve_language("system", ["ja-JP"]), "ja");
        assert_eq!(resolve_language("system", std::iter::empty()), "en");
    }

    #[test]
    fn shared_config_language_maps_zh_cn_and_defaults_only_when_missing() {
        assert_eq!(normalize_preference(Some("zh-Hans")), "zh-Hans");
        assert_eq!(normalize_preference(Some("en")), "en");
        assert_eq!(normalize_preference(Some("fr")), "fr");
        assert_eq!(normalize_preference(Some("garbage")), "en");
        assert_eq!(normalize_preference(Some("zh-CN")), "zh-Hans");
        assert_eq!(normalize_preference(Some("zh-TW")), "zh-Hant");
        assert_eq!(normalize_preference(Some("zh-HK")), "zh-Hant");
        assert_eq!(normalize_preference(None), "system");
    }

    #[test]
    fn english_shortfall_tooltip_keeps_the_separator_after_codeburn() {
        let _lock = LocaleLock::acquire("en");
        assert_eq!(
            format_message(
                "CodeBurn %1$@ · %2$lld of %3$lld devices reporting",
                &[Value::from("$4"), Value::from(1), Value::from(2)]
            ),
            "CodeBurn · $4 · 1 of 2 devices reporting"
        );
    }

    #[test]
    fn format_fills_calls_today_and_the_device_shortfall() {
        let _lock = LocaleLock::acquire("zh-Hans");
        assert_eq!(
            format_message("%@ · no usage yet", &[Value::from("本周")]),
            "本周 · 暂无用量"
        );
        assert_eq!(
            format_message(
                "%1$lld of %2$lld devices",
                &[Value::from(1), Value::from(2)]
            ),
            "1/2 台设备"
        );
        assert_eq!(format_message("1 call", &[]), "1 次调用");
        assert_eq!(format_message("%lld calls", &[Value::from(3)]), "3 次调用");
        assert_eq!(
            format_message(
                "Today · %1$@ · %2$@",
                &[Value::from("$1.0"), Value::from("1 次调用")]
            ),
            "今天 · $1.0 · 1 次调用"
        );
        assert_eq!(
            format_message(
                "CodeBurn %1$@ · %2$lld of %3$lld devices reporting",
                &[Value::from("$4"), Value::from(1), Value::from(2)]
            ),
            "CodeBurn $4 · 1/2 台设备已上报"
        );
    }
}
