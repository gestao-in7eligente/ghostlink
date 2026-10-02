-- The Ghost DJ's equalizer (spec 2026-10-02-ghost-dj-som-e-equalizador-design.md §2; src/ghostDj/). Never edit after merge.
-- One row: the server's equalizer, for every session and every song, kept across restarts.
-- eq_preset: 'default', 'bass', 'pop', 'rock', 'voice', 'electronic' or 'custom'.
-- eq_gains: JSON array of the five bands' gains in whole dB, -12 to +12 (60 Hz, 230 Hz, 910 Hz, 3.6 kHz, 14 kHz).
CREATE TABLE ghost_dj_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  eq_preset TEXT NOT NULL CHECK (length(eq_preset) BETWEEN 1 AND 32),
  eq_gains TEXT NOT NULL CHECK (length(eq_gains) <= 64)
) STRICT;
