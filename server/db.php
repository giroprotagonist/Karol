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

// TODO(security): rotate this shared secret + DB password in a coordinated
// deploy (proxy + api-server + Electron must update together).
define('SHARED_SECRET', 'kar0l_my5ql_pr0xy_2026');
$table  = $_GET['table']  ?? '';
$action = $_GET['action'] ?? '';
$publicActions = [
    'song_catalog:list_public',
    'song_catalog:get_public',
    'song_requests:add_public',
    'song_requests:get_map_public',
    'system:health',
];
$isPublicAction = in_array("$table:$action", $publicActions, true);
$auth = $_SERVER['HTTP_X_KAROL_AUTH'] ?? '';
if (!$isPublicAction && $auth !== SHARED_SECRET) {
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

if (!$table || !$action) {
    karol_respond(['ok' => false, 'error' => 'table and action required'], 400);
}
$allowedTables = ['song_requests', 'library_tags', 'download_archive', 'song_catalog', 'karaoke_jobs', 'media_assets', 'system'];
if (!in_array($table, $allowedTables)) {
    karol_respond(['ok' => false, 'error' => 'invalid table'], 400);
}

// ── Init tables (one-shot) ──
if ($action === 'init') {
    karol_db()->multi_query("
        CREATE TABLE IF NOT EXISTS song_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            video_id VARCHAR(128) NOT NULL,
            requester_name VARCHAR(40) NOT NULL,
            song_title VARCHAR(200) DEFAULT '',
            source_url TEXT,
            karaokeify TINYINT(1) NOT NULL DEFAULT 0,
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
        CREATE TABLE IF NOT EXISTS song_catalog (
            video_id VARCHAR(128) PRIMARY KEY,
            title VARCHAR(500) NOT NULL,
            artist VARCHAR(255) DEFAULT '',
            year SMALLINT DEFAULT NULL,
            duration DECIMAL(10,3) DEFAULT 0,
            tag VARCHAR(16) NOT NULL DEFAULT 'music',
            source VARCHAR(64) DEFAULT '',
            thumbnail_url TEXT,
            media_key VARCHAR(768) DEFAULT '',
            metadata_key VARCHAR(768) DEFAULT '',
            lyrics_key VARCHAR(768) DEFAULT '',
            subtitles_json LONGTEXT,
            local_relpath VARCHAR(768) DEFAULT '',
            size_bytes BIGINT UNSIGNED DEFAULT 0,
            sha256 CHAR(64) DEFAULT '',
            r2_uploaded TINYINT(1) NOT NULL DEFAULT 0,
            available_local TINYINT(1) NOT NULL DEFAULT 1,
            last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_catalog_title (title(191)),
            INDEX idx_catalog_artist (artist),
            INDEX idx_catalog_year (year),
            INDEX idx_catalog_tag (tag),
            INDEX idx_catalog_r2 (r2_uploaded),
            INDEX idx_catalog_seen (last_seen_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS karaoke_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            video_id VARCHAR(128) NOT NULL,
            source_url TEXT,
            recipe VARCHAR(64) NOT NULL DEFAULT 'karaoke-v1',
            idempotency_key VARCHAR(200) NOT NULL,
            status ENUM('queued','claimed','downloading','separating','transcribing','rendering','publishing','uploading','done','error') NOT NULL DEFAULT 'queued',
            stage VARCHAR(48) DEFAULT '',
            progress TINYINT NOT NULL DEFAULT 0,
            attempts INT NOT NULL DEFAULT 0,
            lease_owner VARCHAR(64) DEFAULT '',
            claimed_at DATETIME DEFAULT NULL,
            lease_expires_at DATETIME DEFAULT NULL,
            last_error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            completed_at DATETIME DEFAULT NULL,
            UNIQUE KEY uniq_idempotency (idempotency_key),
            INDEX idx_job_status (status, lease_expires_at),
            INDEX idx_job_video (video_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS media_assets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            video_id VARCHAR(128) NOT NULL,
            role VARCHAR(32) NOT NULL,
            r2_key VARCHAR(700) DEFAULT '',
            local_relpath VARCHAR(700) DEFAULT '',
            size_bytes BIGINT UNSIGNED DEFAULT 0,
            sha256 CHAR(64) DEFAULT '',
            r2_state ENUM('none','pending','uploaded','verified') NOT NULL DEFAULT 'none',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_asset (video_id, role),
            INDEX idx_asset_state (r2_state)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    ");
    // Drain any trailing resultsets
    while (karol_db()->more_results()) { karol_db()->next_result(); }
    karol_db()->query("ALTER TABLE song_requests MODIFY video_id VARCHAR(128) NOT NULL DEFAULT ''");
    $column = karol_db()->query("SHOW COLUMNS FROM song_requests LIKE 'source_url'");
    if ($column && $column->num_rows === 0) karol_db()->query("ALTER TABLE song_requests ADD source_url TEXT AFTER song_title");
    $column = karol_db()->query("SHOW COLUMNS FROM song_requests LIKE 'karaokeify'");
    if ($column && $column->num_rows === 0) karol_db()->query("ALTER TABLE song_requests ADD karaokeify TINYINT(1) NOT NULL DEFAULT 0 AFTER source_url");
    // ── Additive claim/lease + request_type / needs_match migration (idempotent) ──
    karol_db()->query("ALTER TABLE song_requests MODIFY status ENUM('needs_match','queued','claimed','preparing','playing','ended','error') DEFAULT 'queued'");
    $requestColumns = [
        'artist' => "ADD artist VARCHAR(200) DEFAULT '' AFTER song_title",
        'request_type' => "ADD request_type VARCHAR(16) NOT NULL DEFAULT '' AFTER karaokeify",
        'request_uuid' => "ADD request_uuid VARCHAR(64) DEFAULT '' AFTER status",
        'job_id' => "ADD job_id INT DEFAULT NULL AFTER request_uuid",
        'claimed_at' => "ADD claimed_at DATETIME DEFAULT NULL AFTER job_id",
        'lease_owner' => "ADD lease_owner VARCHAR(64) DEFAULT '' AFTER claimed_at",
        'lease_expires_at' => "ADD lease_expires_at DATETIME DEFAULT NULL AFTER lease_owner",
        'attempts' => "ADD attempts INT NOT NULL DEFAULT 0 AFTER lease_expires_at",
        'last_error' => "ADD last_error TEXT AFTER attempts",
        'updated_at' => "ADD updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER requested_at",
    ];
    foreach ($requestColumns as $name => $ddl) {
        $column = karol_db()->query("SHOW COLUMNS FROM song_requests LIKE '$name'");
        if ($column && $column->num_rows === 0) karol_db()->query("ALTER TABLE song_requests $ddl");
    }
    $index = karol_db()->query("SHOW INDEX FROM song_requests WHERE Key_name='idx_lease'");
    if ($index && $index->num_rows === 0) karol_db()->query("ALTER TABLE song_requests ADD INDEX idx_lease (status, lease_expires_at)");
    $index = karol_db()->query("SHOW INDEX FROM song_requests WHERE Key_name='idx_request_type'");
    if ($index && $index->num_rows === 0) karol_db()->query("ALTER TABLE song_requests ADD INDEX idx_request_type (request_type)");
    karol_respond(['ok' => true, 'msg' => 'tables created']);
}

try {
    switch ("$table:$action") {

        case 'system:health':
            karol_respond(['ok' => true, 'service' => 'karol-cloud', 'time' => gmdate('c')]);

        case 'song_catalog:upsert_batch':
            $body = karol_get_body();
            $rows = $body['songs'] ?? [];
            if (!is_array($rows) || count($rows) === 0 || count($rows) > 100) {
                karol_respond(['ok' => false, 'error' => 'songs must contain 1-100 rows'], 400);
            }
            $db = karol_db();
            $db->begin_transaction();
            $sql = "INSERT INTO song_catalog
                (video_id,title,artist,year,duration,tag,source,thumbnail_url,media_key,metadata_key,lyrics_key,subtitles_json,local_relpath,size_bytes,sha256,r2_uploaded,available_local,last_seen_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE
                title=VALUES(title),artist=VALUES(artist),year=VALUES(year),duration=VALUES(duration),
                tag=VALUES(tag),
                source=IF(VALUES(source)='',source,VALUES(source)),
                thumbnail_url=VALUES(thumbnail_url),
                media_key=IF(VALUES(media_key)='',media_key,VALUES(media_key)),
                metadata_key=IF(VALUES(metadata_key)='',metadata_key,VALUES(metadata_key)),
                lyrics_key=IF(VALUES(lyrics_key)='',lyrics_key,VALUES(lyrics_key)),
                subtitles_json=VALUES(subtitles_json),
                local_relpath=IF(VALUES(local_relpath)='',local_relpath,VALUES(local_relpath)),
                size_bytes=VALUES(size_bytes),sha256=IF(VALUES(sha256)='',sha256,VALUES(sha256)),
                r2_uploaded=GREATEST(r2_uploaded,VALUES(r2_uploaded)),
                available_local=VALUES(available_local),last_seen_at=NOW()";
            $stmt = $db->prepare($sql);
            $count = 0;
            foreach ($rows as $song) {
                $vid = substr(trim((string)($song['video_id'] ?? '')), 0, 128);
                $title = substr(trim((string)($song['title'] ?? '')), 0, 500);
                if (!$vid || !$title) continue;
                $artist = substr(trim((string)($song['artist'] ?? '')), 0, 255);
                $year = (int)($song['year'] ?? 0);
                $duration = (float)($song['duration'] ?? 0);
                $tag = substr(trim((string)($song['tag'] ?? 'music')), 0, 16);
                $source = substr(trim((string)($song['source'] ?? '')), 0, 64);
                $thumb = (string)($song['thumbnail_url'] ?? '');
                $mediaKey = substr((string)($song['media_key'] ?? ''), 0, 768);
                $metadataKey = substr((string)($song['metadata_key'] ?? ''), 0, 768);
                $lyricsKey = substr((string)($song['lyrics_key'] ?? ''), 0, 768);
                $subtitles = json_encode($song['subtitles'] ?? [], JSON_UNESCAPED_UNICODE);
                $localPath = substr((string)($song['local_relpath'] ?? ''), 0, 768);
                $size = (int)($song['size_bytes'] ?? 0);
                $sha = substr((string)($song['sha256'] ?? ''), 0, 64);
                $r2 = !empty($song['r2_uploaded']) ? 1 : 0;
                $local = array_key_exists('available_local', $song) ? (!empty($song['available_local']) ? 1 : 0) : 1;
                $stmt->bind_param(
                    'sssidssssssssisii',
                    $vid, $title, $artist, $year, $duration, $tag, $source, $thumb,
                    $mediaKey, $metadataKey, $lyricsKey, $subtitles, $localPath,
                    $size, $sha, $r2, $local
                );
                $stmt->execute();
                $count++;
            }
            $db->commit();
            karol_respond(['ok' => true, 'upserted' => $count]);

        case 'song_catalog:mark_r2_batch':
            $body = karol_get_body();
            $ids = $body['video_ids'] ?? [];
            if (!is_array($ids) || count($ids) === 0 || count($ids) > 200) {
                karol_respond(['ok' => false, 'error' => 'video_ids must contain 1-200 ids'], 400);
            }
            $stmt = karol_db()->prepare("UPDATE song_catalog SET r2_uploaded=1, updated_at=NOW() WHERE video_id=?");
            $count = 0;
            foreach ($ids as $rawId) {
                $vid = substr(trim((string)$rawId), 0, 128);
                if (!$vid) continue;
                $stmt->bind_param('s', $vid);
                $stmt->execute();
                $count += max(0, $stmt->affected_rows);
            }
            karol_respond(['ok' => true, 'updated' => $count]);

        case 'song_catalog:count':
            $row = karol_db()->query("SELECT COUNT(*) AS total, SUM(r2_uploaded=1) AS r2_uploaded, SUM(available_local=1) AS available_local FROM song_catalog")->fetch_assoc();
            karol_respond([
                'ok' => true,
                'total' => (int)($row['total'] ?? 0),
                'r2_uploaded' => (int)($row['r2_uploaded'] ?? 0),
                'available_local' => (int)($row['available_local'] ?? 0),
            ]);

        case 'song_catalog:get_media':
            $vid = substr(trim((string)($_GET['video_id'] ?? '')), 0, 128);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("SELECT video_id,media_key,local_relpath,size_bytes,r2_uploaded FROM song_catalog WHERE video_id=? LIMIT 1");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            karol_respond(['ok' => true, 'row' => $row ?: null]);

        case 'song_catalog:get_public':
            $vid = substr(trim((string)($_GET['video_id'] ?? '')), 0, 128);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("SELECT video_id AS videoId,title,artist,year,duration,tag,source,thumbnail_url AS thumbnail,size_bytes AS size,r2_uploaded AS cloudBacked,available_local AS availableLocal FROM song_catalog WHERE video_id=?");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            $row = $stmt->get_result()->fetch_assoc();
            karol_respond(['ok' => true, 'video' => $row ?: null]);

        case 'song_catalog:list_public':
            $page = max(1, (int)($_GET['page'] ?? 1));
            $limit = min(200, max(1, (int)($_GET['limit'] ?? 100)));
            $offset = ($page - 1) * $limit;
            $q = trim((string)($_GET['q'] ?? ''));
            $year = (int)($_GET['year'] ?? 0);
            $tag = trim((string)($_GET['tag'] ?? ''));
            $where = [];
            $params = [];
            $types = '';
            if ($q !== '') {
                $where[] = "(title LIKE ? OR artist LIKE ? OR video_id LIKE ?)";
                $like = '%' . $q . '%';
                array_push($params, $like, $like, $like);
                $types .= 'sss';
            }
            if ($year > 0) { $where[] = "year=?"; $params[] = $year; $types .= 'i'; }
            if ($tag !== '') { $where[] = "tag=?"; $params[] = $tag; $types .= 's'; }
            $whereSql = $where ? (' WHERE ' . implode(' AND ', $where)) : '';
            $countStmt = karol_db()->prepare("SELECT COUNT(*) AS cnt FROM song_catalog" . $whereSql);
            if ($types !== '') $countStmt->bind_param($types, ...$params);
            $countStmt->execute();
            $total = (int)$countStmt->get_result()->fetch_assoc()['cnt'];
            $sql = "SELECT video_id AS videoId,title,artist,year,duration,tag,source,thumbnail_url AS thumbnail,size_bytes AS size,r2_uploaded AS cloudBacked,available_local AS availableLocal FROM song_catalog"
                . $whereSql . " ORDER BY title ASC LIMIT ? OFFSET ?";
            $listParams = array_merge($params, [$limit, $offset]);
            $listTypes = $types . 'ii';
            $stmt = karol_db()->prepare($sql);
            $stmt->bind_param($listTypes, ...$listParams);
            $stmt->execute();
            $videos = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            karol_respond(['ok' => true, 'count' => $total, 'page' => $page, 'limit' => $limit, 'videos' => $videos]);

        case 'song_requests:list':
            $s = $_GET['status'] ?? '';
            $limit = min((int)($_GET['limit'] ?? 200), 500);
            $sql = "SELECT id, video_id, requester_name, song_title, artist, source_url, karaokeify, request_type, status, request_uuid, job_id, attempts, last_error, lease_expires_at, requested_at FROM song_requests";
            $params = []; $types = '';
            if ($s) { $sql .= " WHERE status = ?"; $params[] = $s; $types .= 's'; }
            $sql .= " ORDER BY id ASC LIMIT ?";
            $params[] = $limit; $types .= 'i';
            $stmt = karol_db()->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            karol_respond(['ok' => true, 'rows' => $rows, 'count' => count($rows)]);

        case 'song_requests:list_needs_match':
            $limit = min((int)($_GET['limit'] ?? 100), 200);
            $stmt = karol_db()->prepare(
                "SELECT id, video_id, requester_name, song_title, artist, source_url, karaokeify, request_type, status, requested_at
                 FROM song_requests WHERE status='needs_match' ORDER BY id ASC LIMIT ?"
            );
            $stmt->bind_param('i', $limit);
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            karol_respond(['ok' => true, 'rows' => $rows, 'count' => count($rows)]);

        case 'song_requests:add':
            $body = karol_get_body();
            $vid  = substr(trim($body['video_id'] ?? ''), 0, 128);
            $name = substr(trim($body['requester_name'] ?? ''), 0, 40);
            $title= substr(trim($body['song_title'] ?? ''), 0, 200);
            $artist = substr(trim((string)($body['artist'] ?? '')), 0, 200);
            $url = substr(trim((string)($body['source_url'] ?? '')), 0, 1000);
            $rtype = substr(trim((string)($body['request_type'] ?? '')), 0, 16);
            if (!in_array($rtype, ['yt_karaoke','karaokify','jukebox','by_name',''])) $rtype = '';
            // Back-compat: karaokeify flag maps to karaokify type when type omitted
            $karaokeify = !empty($body['karaokeify']) ? 1 : 0;
            if ($rtype === '') {
                $rtype = $karaokeify ? 'karaokify' : 'jukebox';
            }
            if ($rtype === 'karaokify') $karaokeify = 1;
            if ($rtype === 'yt_karaoke' || $rtype === 'jukebox') $karaokeify = 0;
            $status = 'queued';
            if ($rtype === 'by_name') {
                $status = 'needs_match';
                $vid = '';
                $karaokeify = 0;
                if (!$name || (!$title && !$artist)) {
                    karol_respond(['ok' => false, 'error' => 'name and title/artist required for by_name'], 400);
                }
            } elseif (!$vid || !$name) {
                karol_respond(['ok' => false, 'error' => 'video_id and requester_name required'], 400);
            }
            $uuid = substr((string)($body['request_uuid'] ?? uniqid('req_', true)), 0, 64);
            $stmt = karol_db()->prepare("INSERT INTO song_requests (video_id, requester_name, song_title, artist, source_url, karaokeify, request_type, status, request_uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->bind_param('sssssisss', $vid, $name, $title, $artist, $url, $karaokeify, $rtype, $status, $uuid);
            $stmt->execute();
            karol_respond(['ok' => true, 'id' => $stmt->insert_id, 'request_uuid' => $uuid, 'status' => $status, 'request_type' => $rtype]);

        case 'song_requests:add_public':
            $body = karol_get_body();
            // Honeypot field used by the public form. Bots that fill it are
            // acknowledged without creating a request.
            if (!empty($body['website'])) karol_respond(['ok' => true, 'queued' => true]);
            $vid = substr(trim((string)($body['videoId'] ?? $body['video_id'] ?? '')), 0, 128);
            $name = substr(trim((string)($body['name'] ?? $body['requester_name'] ?? '')), 0, 40);
            $title = substr(trim((string)($body['title'] ?? $body['song_title'] ?? '')), 0, 200);
            $artist = substr(trim((string)($body['artist'] ?? '')), 0, 200);
            $url = substr(trim((string)($body['url'] ?? $body['source_url'] ?? '')), 0, 1000);
            $rtype = substr(trim((string)($body['request_type'] ?? $body['requestType'] ?? '')), 0, 16);
            if (!in_array($rtype, ['yt_karaoke','karaokify','jukebox','by_name',''])) $rtype = '';
            $karaokeify = !empty($body['karaokeify']) ? 1 : 0;
            if ($rtype === '') {
                $rtype = $karaokeify ? 'karaokify' : ($url ? 'jukebox' : 'jukebox');
            }
            if ($rtype === 'karaokify') $karaokeify = 1;
            if ($rtype === 'yt_karaoke' || $rtype === 'jukebox') $karaokeify = 0;
            if (!$vid && preg_match('/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/', $url, $match)) {
                $vid = $match[1];
            }
            $status = 'queued';
            if ($rtype === 'by_name') {
                $status = 'needs_match';
                $vid = '';
                $karaokeify = 0;
                if (!$name || (!$title && !$artist)) {
                    karol_respond(['ok' => false, 'error' => 'name and song title/artist required'], 400);
                }
            } else {
                if (!$vid || !$name) {
                    karol_respond(['ok' => false, 'error' => 'videoId and name required'], 400);
                }
                $check = karol_db()->prepare("SELECT 1 FROM song_catalog WHERE video_id=? LIMIT 1");
                $check->bind_param('s', $vid);
                $check->execute();
                if (!$check->get_result()->fetch_row() && !$url) {
                    karol_respond(['ok' => false, 'error' => 'song not found'], 404);
                }
            }
            $uuid = substr(uniqid('req_', true), 0, 64);
            $stmt = karol_db()->prepare("INSERT INTO song_requests (video_id, requester_name, song_title, artist, source_url, karaokeify, request_type, status, request_uuid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->bind_param('sssssisss', $vid, $name, $title, $artist, $url, $karaokeify, $rtype, $status, $uuid);
            $stmt->execute();
            karol_respond([
                'ok' => true,
                'id' => $stmt->insert_id,
                'videoId' => $vid,
                'requester' => $name,
                'queued' => $status === 'queued',
                'needs_match' => $status === 'needs_match',
                'request_type' => $rtype,
                'status' => $status,
            ]);

        // DJ attaches a YouTube URL / library video to a by-name request.
        case 'song_requests:fill_match':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            $vid = substr(trim((string)($body['video_id'] ?? $body['videoId'] ?? '')), 0, 128);
            $url = substr(trim((string)($body['url'] ?? $body['source_url'] ?? '')), 0, 1000);
            $rtype = substr(trim((string)($body['request_type'] ?? $body['requestType'] ?? 'karaokify')), 0, 16);
            $title = substr(trim((string)($body['title'] ?? $body['song_title'] ?? '')), 0, 200);
            if (!in_array($rtype, ['yt_karaoke','karaokify','jukebox'])) {
                karol_respond(['ok' => false, 'error' => 'request_type must be yt_karaoke, karaokify, or jukebox'], 400);
            }
            if (!$vid && preg_match('/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/', $url, $match)) {
                $vid = $match[1];
            }
            if (!$id || !$vid) karol_respond(['ok' => false, 'error' => 'id and video_id/url required'], 400);
            $karaokeify = ($rtype === 'karaokify') ? 1 : 0;
            if ($url === '') $url = 'https://www.youtube.com/watch?v=' . $vid;
            if ($title !== '') {
                $stmt = karol_db()->prepare(
                    "UPDATE song_requests
                     SET video_id=?, source_url=?, karaokeify=?, request_type=?, song_title=?,
                         status='queued', lease_owner='', lease_expires_at=NULL
                     WHERE id=? AND status='needs_match'"
                );
                $stmt->bind_param('ssissi', $vid, $url, $karaokeify, $rtype, $title, $id);
            } else {
                $stmt = karol_db()->prepare(
                    "UPDATE song_requests
                     SET video_id=?, source_url=?, karaokeify=?, request_type=?,
                         status='queued', lease_owner='', lease_expires_at=NULL
                     WHERE id=? AND status='needs_match'"
                );
                $stmt->bind_param('ssisi', $vid, $url, $karaokeify, $rtype, $id);
            }
            $stmt->execute();
            if ($stmt->affected_rows < 1) {
                karol_respond(['ok' => false, 'error' => 'request not found or not needs_match'], 404);
            }
            karol_respond(['ok' => true, 'id' => $id, 'videoId' => $vid, 'request_type' => $rtype, 'status' => 'queued']);

        case 'song_requests:update':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            $st = substr(trim($body['status'] ?? ''), 0, 16);
            $err = substr(trim((string)($body['last_error'] ?? '')), 0, 1000);
            if (!$id || !$st) karol_respond(['ok' => false, 'error' => 'id and status required'], 400);
            if (!in_array($st, ['needs_match','queued','claimed','preparing','playing','ended','error']))
                karol_respond(['ok' => false, 'error' => 'invalid status'], 400);
            if ($st === 'queued') {
                // Release back to the durable queue: clear the lease
                $stmt = karol_db()->prepare("UPDATE song_requests SET status='queued', lease_owner='', lease_expires_at=NULL, last_error=? WHERE id=?");
                $stmt->bind_param('si', $err, $id);
            } else {
                $stmt = karol_db()->prepare("UPDATE song_requests SET status=?, last_error=IF(?='', last_error, ?) WHERE id=?");
                $stmt->bind_param('sssi', $st, $err, $err, $id);
            }
            $stmt->execute();
            karol_respond(['ok' => true, 'affected' => $stmt->affected_rows]);

        // Atomically claim queued requests (or requests whose lease expired)
        // for one Mac host. Uses a unique claim token so the exact claimed
        // rows can be selected back without a race.
        case 'song_requests:claim_batch':
            $body = karol_get_body();
            $owner = substr(trim((string)($body['owner'] ?? 'mac')), 0, 40);
            $leaseSec = max(30, min(3600, (int)($body['lease_seconds'] ?? 180)));
            $limit = max(1, min(100, (int)($body['limit'] ?? 25)));
            $token = substr($owner . '#' . bin2hex(random_bytes(8)), 0, 64);
            $stmt = karol_db()->prepare(
                "UPDATE song_requests
                 SET status='claimed', lease_owner=?, claimed_at=NOW(),
                     lease_expires_at=DATE_ADD(NOW(), INTERVAL ? SECOND),
                     attempts=attempts+1
                 WHERE status='queued'
                    OR (status IN ('claimed','preparing') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
                 ORDER BY id ASC LIMIT ?"
            );
            $stmt->bind_param('sii', $token, $leaseSec, $limit);
            $stmt->execute();
            $rows = [];
            if ($stmt->affected_rows > 0) {
                $sel = karol_db()->prepare("SELECT id, video_id, requester_name, song_title, artist, source_url, karaokeify, request_type, status, attempts, requested_at FROM song_requests WHERE lease_owner=? AND status='claimed' ORDER BY id ASC");
                $sel->bind_param('s', $token);
                $sel->execute();
                $rows = $sel->get_result()->fetch_all(MYSQLI_ASSOC);
            }
            karol_respond(['ok' => true, 'claim_token' => $token, 'rows' => $rows, 'count' => count($rows)]);

        // Electron ACK: the request is durably in the local queue → preparing.
        case 'song_requests:ack':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            $leaseSec = max(60, min(86400, (int)($body['lease_seconds'] ?? 7200)));
            if (!$id) karol_respond(['ok' => false, 'error' => 'id required'], 400);
            $stmt = karol_db()->prepare(
                "UPDATE song_requests
                 SET status='preparing', lease_expires_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
                 WHERE id=? AND status IN ('claimed','preparing')"
            );
            $stmt->bind_param('ii', $leaseSec, $id);
            $stmt->execute();
            karol_respond(['ok' => true, 'affected' => $stmt->affected_rows]);

        // Recovery: expired claimed/preparing leases go back to queued;
        // stale playing rows (crashed handoff) are auto-closed.
        case 'song_requests:reclaim_expired':
            $body = karol_get_body();
            $stalePlayingMin = max(0, min(1440, (int)($body['stale_playing_minutes'] ?? 180)));
            $db = karol_db();
            $db->query("UPDATE song_requests SET status='queued', lease_owner='', lease_expires_at=NULL WHERE status IN ('claimed','preparing') AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()");
            $requeued = $db->affected_rows;
            $closed = 0;
            if ($stalePlayingMin > 0) {
                $stmt = $db->prepare("UPDATE song_requests SET status='ended', last_error='auto-closed stale playing' WHERE status='playing' AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)");
                $stmt->bind_param('i', $stalePlayingMin);
                $stmt->execute();
                $closed = $stmt->affected_rows;
            }
            karol_respond(['ok' => true, 'requeued' => $requeued, 'closed_stale_playing' => $closed]);

        case 'song_requests:set_job':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            $jobId = (int)($body['job_id'] ?? 0);
            if (!$id || !$jobId) karol_respond(['ok' => false, 'error' => 'id and job_id required'], 400);
            $stmt = karol_db()->prepare("UPDATE song_requests SET job_id=? WHERE id=?");
            $stmt->bind_param('ii', $jobId, $id);
            $stmt->execute();
            karol_respond(['ok' => true, 'affected' => $stmt->affected_rows]);

        // ── Durable karaoke jobs ──

        // Get-or-create by idempotency key (one generation job per source+recipe).
        case 'karaoke_jobs:upsert':
            $body = karol_get_body();
            $vid = substr(trim((string)($body['video_id'] ?? '')), 0, 128);
            $recipe = substr(trim((string)($body['recipe'] ?? 'karaoke-v1')), 0, 64);
            $url = substr(trim((string)($body['source_url'] ?? '')), 0, 1000);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $key = substr((string)($body['idempotency_key'] ?? ($vid . ':' . $recipe)), 0, 200);
            $stmt = karol_db()->prepare(
                "INSERT INTO karaoke_jobs (video_id, source_url, recipe, idempotency_key)
                 VALUES (?,?,?,?)
                 ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), source_url=IF(VALUES(source_url)='', source_url, VALUES(source_url))"
            );
            $stmt->bind_param('ssss', $vid, $url, $recipe, $key);
            $stmt->execute();
            $jobId = (int)$stmt->insert_id;
            $sel = karol_db()->prepare("SELECT * FROM karaoke_jobs WHERE id=?");
            $sel->bind_param('i', $jobId);
            $sel->execute();
            karol_respond(['ok' => true, 'id' => $jobId, 'job' => $sel->get_result()->fetch_assoc()]);

        case 'karaoke_jobs:claim_batch':
            $body = karol_get_body();
            $owner = substr(trim((string)($body['owner'] ?? 'mac')), 0, 40);
            $leaseSec = max(60, min(14400, (int)($body['lease_seconds'] ?? 1800)));
            $limit = max(1, min(20, (int)($body['limit'] ?? 5)));
            $token = substr($owner . '#' . bin2hex(random_bytes(8)), 0, 64);
            $active = "'claimed','downloading','separating','transcribing','rendering','publishing','uploading'";
            $stmt = karol_db()->prepare(
                "UPDATE karaoke_jobs
                 SET status='claimed', lease_owner=?, claimed_at=NOW(),
                     lease_expires_at=DATE_ADD(NOW(), INTERVAL ? SECOND),
                     attempts=attempts+1
                 WHERE status='queued'
                    OR (status IN ($active) AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW())
                 ORDER BY id ASC LIMIT ?"
            );
            $stmt->bind_param('sii', $token, $leaseSec, $limit);
            $stmt->execute();
            $rows = [];
            if ($stmt->affected_rows > 0) {
                $sel = karol_db()->prepare("SELECT * FROM karaoke_jobs WHERE lease_owner=? AND status='claimed' ORDER BY id ASC");
                $sel->bind_param('s', $token);
                $sel->execute();
                $rows = $sel->get_result()->fetch_all(MYSQLI_ASSOC);
            }
            karol_respond(['ok' => true, 'claim_token' => $token, 'rows' => $rows, 'count' => count($rows)]);

        case 'karaoke_jobs:update':
            $body = karol_get_body();
            $id = (int)($body['id'] ?? 0);
            if (!$id) karol_respond(['ok' => false, 'error' => 'id required'], 400);
            $st = substr(trim((string)($body['status'] ?? '')), 0, 16);
            $validStatuses = ['queued','claimed','downloading','separating','transcribing','rendering','publishing','uploading','done','error'];
            if ($st && !in_array($st, $validStatuses)) karol_respond(['ok' => false, 'error' => 'invalid status'], 400);
            $stage = substr(trim((string)($body['stage'] ?? '')), 0, 48);
            $progress = max(0, min(100, (int)($body['progress'] ?? -1)));
            $hasProgress = isset($body['progress']);
            $err = substr(trim((string)($body['last_error'] ?? '')), 0, 2000);
            $leaseSec = (int)($body['extend_lease_seconds'] ?? 0);
            $sets = [];
            $params = [];
            $types = '';
            if ($st) { $sets[] = 'status=?'; $params[] = $st; $types .= 's'; }
            if ($stage !== '') { $sets[] = 'stage=?'; $params[] = $stage; $types .= 's'; }
            if ($hasProgress) { $sets[] = 'progress=?'; $params[] = $progress; $types .= 'i'; }
            if ($err !== '') { $sets[] = 'last_error=?'; $params[] = $err; $types .= 's'; }
            if ($leaseSec > 0) { $sets[] = 'lease_expires_at=DATE_ADD(NOW(), INTERVAL ? SECOND)'; $params[] = min(14400, $leaseSec); $types .= 'i'; }
            if ($st === 'done' || $st === 'error') { $sets[] = 'completed_at=NOW()'; $sets[] = "lease_owner=''"; $sets[] = 'lease_expires_at=NULL'; }
            if ($st === 'queued') { $sets[] = "lease_owner=''"; $sets[] = 'lease_expires_at=NULL'; }
            if (!$sets) karol_respond(['ok' => false, 'error' => 'nothing to update'], 400);
            $params[] = $id; $types .= 'i';
            $stmt = karol_db()->prepare("UPDATE karaoke_jobs SET " . implode(',', $sets) . " WHERE id=?");
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            karol_respond(['ok' => true, 'affected' => $stmt->affected_rows]);

        case 'karaoke_jobs:get':
            $id = (int)($_GET['id'] ?? 0);
            $vid = substr(trim((string)($_GET['video_id'] ?? '')), 0, 128);
            if ($id) {
                $stmt = karol_db()->prepare("SELECT * FROM karaoke_jobs WHERE id=?");
                $stmt->bind_param('i', $id);
            } elseif ($vid) {
                $recipe = substr(trim((string)($_GET['recipe'] ?? 'karaoke-v1')), 0, 64);
                $stmt = karol_db()->prepare("SELECT * FROM karaoke_jobs WHERE video_id=? AND recipe=? ORDER BY id DESC LIMIT 1");
                $stmt->bind_param('ss', $vid, $recipe);
            } else {
                karol_respond(['ok' => false, 'error' => 'id or video_id required'], 400);
            }
            $stmt->execute();
            karol_respond(['ok' => true, 'job' => $stmt->get_result()->fetch_assoc() ?: null]);

        case 'karaoke_jobs:list':
            $s = substr(trim((string)($_GET['status'] ?? '')), 0, 16);
            $limit = min((int)($_GET['limit'] ?? 100), 500);
            $sql = "SELECT * FROM karaoke_jobs";
            $params = []; $types = '';
            if ($s) { $sql .= " WHERE status=?"; $params[] = $s; $types .= 's'; }
            $sql .= " ORDER BY id DESC LIMIT ?";
            $params[] = $limit; $types .= 'i';
            $stmt = karol_db()->prepare($sql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            karol_respond(['ok' => true, 'rows' => $rows, 'count' => count($rows)]);

        case 'karaoke_jobs:reclaim_expired':
            $active = "'claimed','downloading','separating','transcribing','rendering','publishing','uploading'";
            karol_db()->query("UPDATE karaoke_jobs SET status='queued', lease_owner='', lease_expires_at=NULL WHERE status IN ($active) AND lease_expires_at IS NOT NULL AND lease_expires_at < NOW()");
            karol_respond(['ok' => true, 'requeued' => karol_db()->affected_rows]);

        // ── Per-role media asset / replication tracking ──

        case 'media_assets:upsert_batch':
            $body = karol_get_body();
            $rows = $body['assets'] ?? [];
            if (!is_array($rows) || count($rows) === 0 || count($rows) > 100) {
                karol_respond(['ok' => false, 'error' => 'assets must contain 1-100 rows'], 400);
            }
            $validStates = ['none','pending','uploaded','verified'];
            $stmt = karol_db()->prepare(
                "INSERT INTO media_assets (video_id, role, r2_key, local_relpath, size_bytes, sha256, r2_state)
                 VALUES (?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE
                 r2_key=IF(VALUES(r2_key)='', r2_key, VALUES(r2_key)),
                 local_relpath=IF(VALUES(local_relpath)='', local_relpath, VALUES(local_relpath)),
                 size_bytes=IF(VALUES(size_bytes)=0, size_bytes, VALUES(size_bytes)),
                 sha256=IF(VALUES(sha256)='', sha256, VALUES(sha256)),
                 r2_state=VALUES(r2_state), updated_at=NOW()"
            );
            $count = 0;
            foreach ($rows as $asset) {
                $vid = substr(trim((string)($asset['video_id'] ?? '')), 0, 128);
                $role = substr(trim((string)($asset['role'] ?? '')), 0, 32);
                if (!$vid || !$role) continue;
                $key = substr((string)($asset['r2_key'] ?? ''), 0, 700);
                $rel = substr((string)($asset['local_relpath'] ?? ''), 0, 700);
                $size = (int)($asset['size_bytes'] ?? 0);
                $sha = substr((string)($asset['sha256'] ?? ''), 0, 64);
                $state = in_array($asset['r2_state'] ?? '', $validStates, true) ? $asset['r2_state'] : 'none';
                $stmt->bind_param('ssssiss', $vid, $role, $key, $rel, $size, $sha, $state);
                $stmt->execute();
                $count++;
            }
            karol_respond(['ok' => true, 'upserted' => $count]);

        case 'media_assets:mark_state':
            $body = karol_get_body();
            $vid = substr(trim((string)($body['video_id'] ?? '')), 0, 128);
            $state = (string)($body['r2_state'] ?? '');
            $roles = $body['roles'] ?? [];
            if (!$vid || !in_array($state, ['none','pending','uploaded','verified'], true)) {
                karol_respond(['ok' => false, 'error' => 'video_id and valid r2_state required'], 400);
            }
            if (is_array($roles) && count($roles) > 0) {
                $stmt = karol_db()->prepare("UPDATE media_assets SET r2_state=?, updated_at=NOW() WHERE video_id=? AND role=?");
                $count = 0;
                foreach ($roles as $rawRole) {
                    $role = substr(trim((string)$rawRole), 0, 32);
                    if (!$role) continue;
                    $stmt->bind_param('sss', $state, $vid, $role);
                    $stmt->execute();
                    $count += max(0, $stmt->affected_rows);
                }
                karol_respond(['ok' => true, 'updated' => $count]);
            }
            $stmt = karol_db()->prepare("UPDATE media_assets SET r2_state=?, updated_at=NOW() WHERE video_id=?");
            $stmt->bind_param('ss', $state, $vid);
            $stmt->execute();
            karol_respond(['ok' => true, 'updated' => $stmt->affected_rows]);

        case 'media_assets:list':
            $vid = substr(trim((string)($_GET['video_id'] ?? '')), 0, 128);
            if (!$vid) karol_respond(['ok' => false, 'error' => 'video_id required'], 400);
            $stmt = karol_db()->prepare("SELECT video_id, role, r2_key, local_relpath, size_bytes, sha256, r2_state, updated_at FROM media_assets WHERE video_id=? ORDER BY role");
            $stmt->bind_param('s', $vid);
            $stmt->execute();
            karol_respond(['ok' => true, 'rows' => $stmt->get_result()->fetch_all(MYSQLI_ASSOC)]);

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

        case 'song_requests:get_map_public':
            $stmt = karol_db()->prepare("SELECT video_id, requester_name FROM song_requests WHERE status IN ('queued','claimed','preparing','playing') ORDER BY id ASC LIMIT 500");
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
