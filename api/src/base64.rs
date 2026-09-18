//! base64url helpers, shared by the token signer and the Web Push encoder.
//!
//! Ported from `src/lib/base64.ts`, which is `btoa`/`atob` with three edits:
//! `+` becomes `-`, `/` becomes `_`, and trailing `=` is stripped on the way
//! out and re-added on the way in.
//!
//! The two browser primitives are more forgiving than a base64 library's
//! defaults, and every one of those liberties is reachable from the wire — the
//! signature segment of a token is attacker-supplied text — so `atob`'s rules
//! are reproduced here rather than approximated: whitespace is ignored, padding
//! is optional but must be well-formed, and the leftover bits of a truncated
//! final group are discarded instead of rejected.

/// `btoa`'s alphabet with the two URL-safe substitutions already applied, which
/// is all `.replaceAll('+', '-').replaceAll('/', '_')` amounted to.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// What `atob` throws: `InvalidCharacterError`. Callers that wrapped the call in
/// `try`/`catch` map this to their documented failure value; the ones that did
/// not let it travel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCharacter;

/// `b64urlEncode` — no padding, no line breaks, empty in gives empty out.
pub fn b64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let packed = (u32::from(group[0]) << 16)
            | (u32::from(group.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(group.get(2).copied().unwrap_or(0));
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        // A short final group loses the characters that would carry only the
        // padding bits — the `=` `btoa` would have written and the regex stripped.
        if group.len() > 1 {
            out.push(ALPHABET[(packed >> 6) as usize & 63] as char);
        }
        if group.len() > 2 {
            out.push(ALPHABET[packed as usize & 63] as char);
        }
    }
    out
}

/// `b64urlDecode`.
///
/// Padding is computed from the input's own length before anything else
/// happens, so a length of `4n + 1` produces three `=` and a string `atob`
/// refuses — which is the intended way a malformed segment fails.
pub fn b64url_decode(value: &str) -> Result<Vec<u8>, InvalidCharacter> {
    // `padEnd` and `.length` count UTF-16 code units. Any input where that
    // differs from a count of chars contains a non-ASCII character and is
    // rejected below regardless, but the arithmetic is spelled out to match.
    let length: usize = value.chars().map(char::len_utf16).sum();
    let padding = length.div_ceil(4) * 4 - length;

    // `atob` begins by removing ASCII whitespace — tab, LF, FF, CR and space,
    // and no others. Doing it while the URL-safe pair is mapped back is the
    // same sequence of characters, since `=` only ever lands on the end.
    let mut data = Vec::with_capacity(length + padding);
    for c in value.chars() {
        match c {
            '\t' | '\n' | '\u{c}' | '\r' | ' ' => {}
            '-' => data.push(b'+'),
            '_' => data.push(b'/'),
            c if c.is_ascii() => data.push(c as u8),
            // Nothing outside ASCII is in the alphabet, is whitespace, or is
            // `=`, so it can only ever be the character `atob` complains about.
            _ => return Err(InvalidCharacter),
        }
    }
    data.extend(std::iter::repeat(b'=').take(padding));

    // Padding is only recognised on a properly sized string, and only two of it.
    if data.len() % 4 == 0 {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    // One character left over cannot be the tail of anything.
    if data.len() % 4 == 1 {
        return Err(InvalidCharacter);
    }

    let mut out = Vec::with_capacity(data.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            // Leftover `=` included: it is not in the alphabet, and by this
            // point the well-formed padding has already been taken off.
            _ => return Err(InvalidCharacter),
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits == 24 {
            out.push((buffer >> 16) as u8);
            out.push((buffer >> 8) as u8);
            out.push(buffer as u8);
            buffer = 0;
            bits = 0;
        }
    }
    // 12 or 18 bits can remain — 6 cannot, the length check above saw to that.
    // The bits past the last whole byte are dropped, not checked for zero.
    if bits == 12 {
        out.push((buffer >> 4) as u8);
    } else if bits == 18 {
        out.push((buffer >> 10) as u8);
        out.push((buffer >> 2) as u8);
    }
    Ok(out)
}

/// `concatBytes` — left to right into one buffer.
pub fn concat_bytes(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// `utf8` — `TextEncoder().encode`, which for a Rust `str` is what it already is.
pub fn utf8(value: &str) -> &[u8] {
    value.as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Every value here came out of `node` running the original `base64.ts`.
    #[test]
    fn encodes_like_btoa() {
        assert_eq!(b64url_encode(&[]), "");
        assert_eq!(b64url_encode(&[0xff]), "_w");
        assert_eq!(b64url_encode(&[0xff, 0xee]), "_-4");
        assert_eq!(b64url_encode(&[0xff, 0xee, 0xdd]), "_-7d");
        assert_eq!(b64url_encode("Nguyễn Văn A ⚽".as_bytes()), "Tmd1eeG7hW4gVsSDbiBBIOKavQ");

        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(
            b64url_encode(&all),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-\
             P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9\
             fn-AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq-wsbKztLW2t7i5uru8\
             vb6_wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t_g4eLj5OXm5-jp6uvs7e7v8PHy8_T19vf4-fr7\
             _P3-_w"
        );
    }

    #[test]
    fn decodes_padded_and_unpadded() {
        assert_eq!(hex(&b64url_decode("_-4").unwrap()), "ffee");
        assert_eq!(hex(&b64url_decode("_-7d").unwrap()), "ffeedd");
        assert_eq!(hex(&b64url_decode("_-4=").unwrap()), "ffee");
        assert_eq!(hex(&b64url_decode("").unwrap()), "");
        assert_eq!(hex(&b64url_decode("AAA=").unwrap()), "0000");
        assert_eq!(hex(&b64url_decode("AA==").unwrap()), "00");
        // The standard alphabet survives the substitution untouched, so it
        // decodes too.
        assert_eq!(hex(&b64url_decode("/+4").unwrap()), "ffee");
    }

    /// `atob` discards the bits past the last whole byte rather than insisting
    /// they be zero — `_-8` and `_-4` decode to different things only in the
    /// bits that are kept.
    #[test]
    fn keeps_only_whole_bytes() {
        assert_eq!(hex(&b64url_decode("_-8").unwrap()), "ffef");
        assert_eq!(hex(&b64url_decode("_-4").unwrap()), "ffee");
    }

    #[test]
    fn rejects_what_atob_rejects() {
        // 4n+1 characters: three `=` are added and the result is unusable.
        assert_eq!(b64url_decode("A"), Err(InvalidCharacter));
        assert_eq!(b64url_decode("!!!!"), Err(InvalidCharacter));
        // Whitespace is dropped, but the padding was sized before it went.
        assert_eq!(b64url_decode("AA AA"), Err(InvalidCharacter));
        assert_eq!(b64url_decode("AA\nAA"), Err(InvalidCharacter));
        // Padding is only stripped from a multiple of four, and only two of it.
        assert_eq!(b64url_decode("AAAA="), Err(InvalidCharacter));
        // `=` anywhere but the end is just a bad character.
        assert_eq!(b64url_decode("AA=A"), Err(InvalidCharacter));
        assert_eq!(b64url_decode("é"), Err(InvalidCharacter));
    }

    #[test]
    fn round_trips() {
        for length in 0..40usize {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 37 % 256) as u8).collect();
            assert_eq!(b64url_decode(&b64url_encode(&bytes)).unwrap(), bytes);
        }
    }

    #[test]
    fn concatenates_in_order() {
        assert_eq!(hex(&concat_bytes(&[&[1, 2], &[], &[3]])), "010203");
        assert_eq!(concat_bytes(&[]), Vec::<u8>::new());
    }
}
