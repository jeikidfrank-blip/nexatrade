<?php
/**
 * Example server endpoint for Megapay STK push (NexaTrade).
 *
 * WHY THIS EXISTS:
 * - The Megapay sample calls https://megapay.co.ke/backend/v1/initiatestk with
 *   an api_key. That api_key is SECRET and must never be placed in browser code
 *   (index.html/app.js/supabase-config.js). Host this script on your server and
 *   set window.NEXATRADE_MEGAPAY_CONFIG.checkoutUrl to this script's URL, with
 *   simulate: false.
 *
 * IMPORTANT:
 * - This only INITIATES the STK push. Do NOT credit a user balance from this
 *   response or from a browser redirect. Credit only from a verified Megapay
 *   webhook/callback on your server (idempotent: store and reject duplicate
 *   event/transaction IDs).
 * - Add authentication/authorization so only logged-in users can create deposits
 *   for their own account, and validate amount/reference against your records.
 */

// === CONFIGURE ON SERVER (do not commit real secrets) ===
$MEGAPAY_API_KEY = getenv('MEGAPAY_API_KEY') ?: ''; // set in server environment
$MEGAPAY_EMAIL   = getenv('MEGAPAY_EMAIL') ?: '';   // your Megapay account email, if required
$MEGAPAY_INITIATE_URL = 'https://megapay.co.ke/backend/v1/initiatestk';

header('Content-Type: application/json; charset=utf-8');
// If your frontend is on a different origin, set a specific origin instead of *.
// header('Access-Control-Allow-Origin: https://your-frontend.example.com');
// header('Access-Control-Allow-Headers: Content-Type');
// header('Access-Control-Allow-Methods: POST, OPTIONS');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed. Use POST.']);
    exit;
}

$raw = file_get_contents('php://input');
$input = json_decode($raw, true);
if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid JSON body.']);
    exit;
}

$amount    = isset($input['amount']) ? (string)$input['amount'] : '';
$msisdn    = isset($input['msisdn']) ? preg_replace('/\D+/', '', (string)$input['msisdn']) : '';
$reference = isset($input['reference']) ? (string)$input['reference'] : ('MP-' . time());
$email     = isset($input['email']) && $input['email'] !== '' ? (string)$input['email'] : $MEGAPAY_EMAIL;

if ($MEGAPAY_API_KEY === '') {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Server is not configured: set MEGAPAY_API_KEY.']);
    exit;
}

if ($amount === '' || !is_numeric($amount) || (float)$amount <= 0) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'A valid amount is required.']);
    exit;
}

if ($msisdn === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'A valid msisdn (phone number) is required.']);
    exit;
}

// Normalize common Kenyan formats to 07XXXXXXXX for this provider sample.
if (strlen($msisdn) === 12 && substr($msisdn, 0, 3) === '254') {
    $msisdn = '0' . substr($msisdn, 3);
} elseif (strlen($msisdn) === 9 && substr($msisdn, 0, 1) === '7') {
    $msisdn = '0' . $msisdn;
}

$payload = json_encode([
    'api_key'   => $MEGAPAY_API_KEY,
    'email'     => $email,
    'amount'    => $amount,
    'msisdn'    => $msisdn,
    'reference' => $reference,
]);

$ch = curl_init($MEGAPAY_INITIATE_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_TIMEOUT        => 30,
]);

$response = curl_exec($ch);
$curlErr  = curl_error($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Could not reach Megapay.', 'detail' => $curlErr]);
    exit;
}

// Forward Megapay's response to the frontend as-is (JSON). The frontend treats
// HTTP errors or obvious failure fields as a failed initiation.
http_response_code($httpCode >= 200 && $httpCode < 600 ? $httpCode : 502);
$decoded = json_decode($response, true);
if ($decoded === null) {
    echo json_encode(['ok' => true, 'raw' => $response, 'reference' => $reference]);
} else {
    // Ensure a reference is available for the UI.
    if (!isset($decoded['reference'])) {
        $decoded['reference'] = $reference;
    }
    echo $response;
}
?>