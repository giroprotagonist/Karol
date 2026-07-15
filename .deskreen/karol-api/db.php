<?php
/**
 * Karol MySQL Proxy — thin REST wrapper for the nukulars_karol database.
 * Deploy to: public_html/karol-api/db.php on Bluehost.
 */
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Karol-Auth');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

define('SHARED_SECRET', 'kar0l_my5ql_pr0xy_2026');
$auth = $_SERVER['HTTP_X_KAROL_AUTH'] ?? '';
if ($auth !== SHARED_SECRET) {
    http_response_code(401);
    die(json_encode(['ok' => false, 'error' => 'unauthorized']));
}

define('DB_HOST', 'localhost');
define('DB_USER', 'nukulars_karol');
define('DB_PASS', '0ekf(a4^,6U6');
define('DB_NAME', 'nukulars_karol');

function karol_db(): mysqli {
    static $conn = null;
    if ($conn === null) {
        $conn = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME);
        if ($conn->connect_error) {
            http_response_code(500);
            die(json_encode(['ok' => false, 'error' => 'db connect failed: ' . $conn->connect_error]));
        }
        $conn->set_charset('utf8mb4');
    }
    return $conn;
}

function karol_get_body(): array {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function karol_respond($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

$table  = $_GET['table']  ?? '';
$action = $_GET['action'] ?? '';
if (!$table || !$action) {
    karol_respond(['ok' => false, 'error' => 'table and action required'], 400);
}
$allowedTables = ['song_requests', 'library_tags', 'download_archive'];
if (!in_array($table, $allowedTables)) {
    karol_respond(['ok' => false, 'error' => 'invalid table'], 400);
}

// ── Init tables (one-shot) ──
if ($action === 'init') {
    karol_db()->multi_query("
        CREATE TABLE IF NOT EXISTS song_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            video_id VARCHAR(11) NOT NULL,
            requester_name VARCHAR(40) NOT NULL,
            song_title VARCHAR(200) DEFAULT '',
            status ENUM('queued','playing','ended','error') DEFAULT 'queued',
            requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_video_id (video_id),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS library_tags (
            video_id VARCHAR(11) PRIMARY KEY,
            tag VARCHAR(16) NOT NULL DEFAULT 'song',
            artist VARCHAR(200) DEFAULT '',
            year INT DEFAULT NULL,
            source VARCHAR(32) DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_tag (tag),
            INDEX idx_artist (artist),
            INDEX idx_year (year)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS download_archive (
            video_id VARCHAR(11) PRIMARY KEY,
            downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");
    // Drain any trailing resultsets
    while (karol_db()->more_results()) { karol_db()->next_result(); }
    karol_respond(['ok' => true, 'msg' => 'tables created']);
}

try {
    switch ("$table:$action") {

        case 'song_requests:list':
            $s = $_GET['status'] ?? '';
            $limit = min((int)($_GET['limit'] ?? 200), 500);
            $sql = "SELECT id, video_id, requester_name, song_title, status, requested_at FROM song_requests";
            $params = []; $types = '';
            if ($s) { $sql .= " WHERE status = ?"; $params[] = $s; $types .= 's'; }
            $sql .= " ORDER BY id ASC LIMIT ?";
            $params[] = $limit; $types .= 'i';
            $stmt = karol_db()->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            karol_respond(['ok' => true, 'rows' => $rows, 'count' => count($rows)]);

        case 'song_requests:add':
            $body = karol_get_body();
            $vid  = substr(trim($body['video_id'] ?? ''), 0, 11);
            $name = substr(trim($body['requester_name'] ?? ''), 0, 40);
            $title= substr(trim($body['song_title'] ?? ''), 0, 200);
            if (!$vid || !$name) {
                karol_respond(['ok' => false, 'error' => 'video_id and requester_name required'], 400);
            }
            $stmt = karol_db()->prepare("INSERT INTO song_requests (video_id, requester_name, song_title) VALUES (?, ?, ?)");
            $stmt->bind_param('sss', $vid, $name, $title);
            $stmt->execute();
            karol_respond(['ok' => true, 'id' => $stmt->insert_id]);

        case 'song_requests:update':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            $st = substr(trim($body['status'] ?? ''), 0, 16);
            if (!$id || !$st) karol_respond(['ok' => false, 'error' => 'id and status required'], 400);
            if (!in_array($st, ['queued','playing','ended','error']))
                karol_respond(['ok' => false, 'error' => 'invalid status'], 400);
            $stmt = karol_db()->prepare("UPDATE song_requests SET status = ? WHERE id = ?");
            $stmt->bind_param('si', $st, $id);
            $stmt->execute();
            karol_respond(['ok' => true, 'affected' => $stmt->affected_rows]);

        case 'song_requests:clear':
            karol_db()->query("DELETE FROM song_requests");
            karol_respond(['ok' => true]);

        case 'song_requests:get_map':
            $stmt = karol_db()->prepare("SELECT video_id, requester_name FROM song_requests ORDER BY id ASC");
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $map = [];
            foreach ($rows as $r) { $map[$r['video_id']] = $r['requester_name']; }
            karol_respond(['ok' => true, 'requestMap' => $map, 'count' => count($map)]);

        case 'library_tags:get':
            $vid = substr(trim($_GET['video_id'] ?? ''), 0, 11);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("SELECT video_id, tag, artist, year, source, updated_at FROM library_tags WHERE video_id = ?");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            karol_respond(['ok' => true, 'row' => $row ?: null]);

        case 'library_tags:set':
            $body = karol_get_body();
            $vid  = substr(trim($body['video_id'] ?? ''), 0, 11);
            $tag  = substr(trim($body['tag'] ?? 'song'), 0, 16);
            $art  = substr(trim($body['artist'] ?? ''), 0, 200);
            $year = (int)($body['year'] ?? 0);
            $src  = substr(trim($body['source'] ?? ''), 0, 32);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            if (!in_array($tag, ['karaoke','song','music',''])) $tag = 'song';
            $stmt = karol_db()->prepare("INSERT INTO library_tags (video_id, tag, artist, year, source) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE tag=VALUES(tag), artist=VALUES(artist), year=VALUES(year), source=VALUES(source), updated_at=NOW()");
            $stmt->bind_param('sssis', $vid, $tag, $art, $year, $src);
            $stmt->execute();
            karol_respond(['ok' => true]);

        case 'library_tags:list_all':
            $limit = min((int)($_GET['limit'] ?? 5000), 10000);
            $stmt = karol_db()->prepare("SELECT video_id, tag, artist, year, source FROM library_tags ORDER BY video_id LIMIT ?");
            $stmt->bind_param('i', $limit);
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $map = [];
            foreach ($rows as $r) { $vid = $r['video_id']; unset($r['video_id']); $map[$vid] = $r; }
            karol_respond(['ok' => true, 'tags' => $map, 'count' => count($map)]);

        case 'library_tags:count_by_tag':
            $stmt = karol_db()->prepare("SELECT tag, COUNT(*) AS cnt FROM library_tags GROUP BY tag");
            $stmt->execute();
            $res = $stmt->get_result();
            $counts = [];
            while ($r = $res->fetch_assoc()) { $counts[$r['tag']] = (int)$r['cnt']; }
            karol_respond(['ok' => true, 'counts' => $counts]);

        case 'download_archive:check':
            $vid = substr(trim($_GET['video_id'] ?? ''), 0, 11);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("SELECT COUNT(*) AS cnt FROM download_archive WHERE video_id = ?");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            $r = $stmt->get_result()->fetch_assoc();
            karol_respond(['ok' => true, 'exists' => ($r['cnt'] ?? 0) > 0]);

        case 'download_archive:add':
            $body = karol_get_body();
            $vid = substr(trim($body['video_id'] ?? ''), 0, 11);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("INSERT IGNORE INTO download_archive (video_id) VALUES (?)");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            karol_respond(['ok' => true, 'inserted' => $stmt->affected_rows > 0]);

        case 'download_archive:check_batch':
            $raw = $_GET['video_ids'] ?? '';
            $ids = array_values(array_filter(array_map(function($v){return substr(trim($v),0,11);}, explode(',', $raw))));
            if (empty($ids)) karol_respond(['ok' => false, 'error' => 'video_ids required'], 400);
            $ph = implode(',', array_fill(0, count($ids), '?'));
            $types = str_repeat('s', count($ids));
            $stmt = karol_db()->prepare("SELECT video_id FROM download_archive WHERE video_id IN ($ph)");
            $stmt->bind_param($types, ...$ids);
            $stmt->execute();
            $found = [];
            while ($r = $stmt->get_result()->fetch_assoc()) { $found[] = $r['video_id']; }
            karol_respond(['ok' => true, 'found' => $found]);

        case 'download_archive:count':
            $r = karol_db()->query("SELECT COUNT(*) AS cnt FROM download_archive")->fetch_assoc();
            karol_respond(['ok' => true, 'count' => (int)($r['cnt'] ?? 0)]);

        default:
            karol_respond(['ok' => false, 'error' => "unknown: $table:$action"], 400);
    }
} catch (Exception $e) {
    karol_respond(['ok' => false, 'error' => $e->getMessage()], 500);
}
