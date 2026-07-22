-- Karol MySQL Schema for nukulars_karol database
-- Run via PHPMyAdmin or: mysql -u nukulars_karol -p nukulars_karol < schema.sql

-- Request lifecycle:
--   needs_match  by-name request waiting for DJ to attach a YouTube URL / library match
--   queued       durable in MySQL; Mac may be offline
--   claimed      a Mac host claimed the row (lease-based; expires back to queued)
--   preparing    Electron ACKed and accepted it into the local queue
--   playing      the player actually started this request
--   ended        playback finished
--   error        handoff or playback failed
-- request_type: yt_karaoke | karaokify | jukebox | by_name
CREATE TABLE IF NOT EXISTS song_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_id VARCHAR(128) NOT NULL DEFAULT '',
    requester_name VARCHAR(40) NOT NULL,
    song_title VARCHAR(200) DEFAULT '',
    artist VARCHAR(200) DEFAULT '',
    source_url TEXT,
    karaokeify TINYINT(1) NOT NULL DEFAULT 0,
    request_type VARCHAR(16) NOT NULL DEFAULT '',
    status ENUM('needs_match','queued','claimed','preparing','playing','ended','error') DEFAULT 'queued',
    request_uuid VARCHAR(64) DEFAULT '',
    job_id INT DEFAULT NULL,
    claimed_at DATETIME DEFAULT NULL,
    lease_owner VARCHAR(64) DEFAULT '',
    lease_expires_at DATETIME DEFAULT NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_video_id (video_id),
    INDEX idx_status (status),
    INDEX idx_lease (status, lease_expires_at),
    INDEX idx_job (job_id),
    INDEX idx_request_type (request_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Durable karaoke generation jobs. One job per source video + recipe;
-- multiple song_requests may point at the same job via job_id.
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

-- Per-role asset + replication tracking. video_id may be a base id or a
-- '-karaoke' variant id; each (video_id, role) pair is one asset.
-- r2_state: none → pending → uploaded → verified
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

-- Authoritative song catalog. Media bytes live in R2 and on the local USB
-- cache; this table is the durable index used by the website and Electron.
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
