-- R2孤児スイープの走査位置。1日1ページずつ進め、末尾到達で先頭へ戻る。
CREATE TABLE r2_sweep_cursors (
  prefix TEXT PRIMARY KEY,
  start_after TEXT,
  updated_at TEXT NOT NULL
);
