-- Karol MySQL Schema for nukulars_karol database
-- Run via PHPMyAdmin or: mysql -u nukulars_karol -p nukulars_karol < schema.sql

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
