//! CORS, reproducing `hono/cors` as `corsMiddleware()` configured it.
//!
//! The headers are computed before any handler runs and applied to whatever
//! response comes back — including error responses — because that is what the
//! original did by setting them on the context's response up front.

use worker::{Headers, Method, Request, Response, Result as WorkerResult};

const ALLOW_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,QUERY,OPTIONS";
const ALLOW_HEADERS: &str = "Content-Type,Authorization,X-Invite-Code";
const MAX_AGE: &str = "86400";

pub struct Cors {
    /// The value for `Access-Control-Allow-Origin`, when the origin is allowed.
    allow_origin: Option<String>,
    /// `Vary`, which echoes the request's own when it carried one.
    vary: String,
    /// Present only on a preflight, and only when the request asked.
    request_headers: Option<String>,
    is_preflight: bool,
}

impl Cors {
    pub fn read(req: &Request, web_origin: &str) -> Self {
        let origin = req.headers().get("Origin").ok().flatten().unwrap_or_default();
        let allow_origin = allowed(&origin, web_origin);
        let vary = req
            .headers()
            .get("Vary")
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Origin".to_string());
        Self {
            allow_origin,
            vary,
            request_headers: req.headers().get("Access-Control-Request-Headers").ok().flatten(),
            is_preflight: req.method() == Method::Options,
        }
    }

    pub fn is_preflight(&self) -> bool {
        self.is_preflight
    }

    fn write_common(&self, headers: &Headers) -> WorkerResult<()> {
        if let Some(origin) = &self.allow_origin {
            headers.set("Access-Control-Allow-Origin", origin)?;
        }
        // `origin` is a function rather than the literal `*`, so `Vary` is set.
        headers.set("Vary", &self.vary)?;
        // `credentials: true` is unconditional — it does not wait for a match.
        headers.set("Access-Control-Allow-Credentials", "true")?;
        /*
         * The server's own clock, in milliseconds, on every response.
         *
         * Two phones can disagree about the time by seconds, which is fatal to
         * anything the group is supposed to see simultaneously: the team draw
         * carries a server timestamp, and a client that schedules against it
         * using its own `Date.now()` is off by whatever its clock is off by.
         * This lets each client measure that difference and correct for it.
         *
         * Not the standard `Date` header, which would otherwise do: it has
         * one-second granularity, and one second is far larger than the skew
         * being corrected. It also has to be named in `Expose-Headers` either
         * way, since the API and the app are different origins in production
         * and `Date` is not on the CORS safelist.
         */
        headers.set("X-Server-Now", &crate::js::now_ms().to_string())?;
        headers.set("Access-Control-Expose-Headers", "X-Server-Now")?;
        Ok(())
    }

    /// The 204 a preflight gets, without ever reaching routing or auth.
    pub fn preflight(&self) -> WorkerResult<Response> {
        let response = Response::empty()?.with_status(204);
        let headers = response.headers();
        self.write_common(headers)?;
        headers.set("Access-Control-Max-Age", MAX_AGE)?;
        headers.set("Access-Control-Allow-Methods", ALLOW_METHODS)?;
        headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS)?;
        if self.request_headers.is_some() {
            headers.set("Vary", &format!("{}, Access-Control-Request-Headers", self.vary))?;
        }
        headers.delete("Content-Length")?;
        headers.delete("Content-Type")?;
        Ok(response)
    }

    /// Merge the headers onto a real response.
    pub fn apply(&self, response: Response) -> WorkerResult<Response> {
        self.write_common(response.headers())?;
        Ok(response)
    }
}

/// `origin(origin)`: the configured web origin exactly, or any plain-http
/// localhost / 127.0.0.1 with an optional port. Everything else is refused by
/// omitting the header.
fn allowed(origin: &str, web_origin: &str) -> Option<String> {
    if origin.is_empty() {
        return None;
    }
    if origin == web_origin {
        return Some(origin.to_string());
    }
    if is_local(origin) {
        return Some(origin.to_string());
    }
    None
}

/// `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/` — anchored, `http:` only.
fn is_local(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    let rest = match rest.strip_prefix("localhost") {
        Some(rest) => rest,
        None => match rest.strip_prefix("127.0.0.1") {
            Some(rest) => rest,
            None => return false,
        },
    };
    if rest.is_empty() {
        return true;
    }
    let Some(port) = rest.strip_prefix(':') else {
        return false;
    };
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
}
