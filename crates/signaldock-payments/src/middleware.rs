//! Axum middleware for x402 payment gating.

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use tracing::{info, warn};

use super::facilitator::FacilitatorClient;
use super::types::{PaymentPayload, PaymentRequired};

/// Axum middleware that enforces x402 payment requirements.
///
/// Checks for the `X-PAYMENT` header. If absent, returns
/// 402 with `X-PAYMENT-REQUIRED` header containing the
/// base64-encoded payment requirement. If present, verifies
/// the payment via the facilitator.
///
/// The facilitator URL is read from the `X402_FACILITATOR_URL`
/// environment variable, defaulting to `https://x402.org/facilitator`.
///
/// If the facilitator is unreachable, the middleware applies
/// graceful degradation and allows the request through.
pub async fn payment_gate(headers: HeaderMap, request: Request<Body>, next: Next) -> Response {
    // Check if route has payment requirement in extensions
    let requirement = request.extensions().get::<PaymentRequired>().cloned();

    let Some(requirement) = requirement else {
        // No payment requirement on this route
        return next.run(request).await;
    };

    // Check for payment header
    if let Some(payment_header) = headers.get("x-payment") {
        let payment_str = match payment_header.to_str() {
            Ok(s) => s,
            Err(_) => return payment_required_response(&requirement),
        };

        // Decode base64 payment payload
        let decoded = match BASE64.decode(payment_str) {
            Ok(d) => d,
            Err(_) => {
                warn!("invalid base64 in X-PAYMENT header");
                return payment_required_response(&requirement);
            }
        };

        let payment: PaymentPayload = match serde_json::from_slice(&decoded) {
            Ok(p) => p,
            Err(_) => {
                warn!("invalid JSON in X-PAYMENT payload");
                return payment_required_response(&requirement);
            }
        };

        // Verify via facilitator
        let facilitator_url = std::env::var("X402_FACILITATOR_URL")
            .unwrap_or_else(|_| "https://x402.org/facilitator".to_string());
        let client = FacilitatorClient::new(&facilitator_url);

        match client.verify(&payment).await {
            Ok(true) => {
                info!("payment verified, allowing request");
                return next.run(request).await;
            }
            Ok(false) => {
                warn!("payment verification failed");
                return payment_required_response(&requirement);
            }
            Err(e) => {
                warn!(error = %e, "facilitator unreachable, allowing request");
                // Graceful degradation: allow if facilitator is down
                return next.run(request).await;
            }
        }
    }

    // No payment header — return 402
    payment_required_response(&requirement)
}

fn payment_required_response(requirement: &PaymentRequired) -> Response {
    let json = serde_json::to_string(requirement).unwrap_or_default();
    let encoded = BASE64.encode(json.as_bytes());

    (
        StatusCode::PAYMENT_REQUIRED,
        [(
            header::HeaderName::from_static("x-payment-required"),
            encoded,
        )],
        "Payment Required",
    )
        .into_response()
}
