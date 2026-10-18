# hanoi-ward-lookup

Fills `origin_ward_id` / `destination_ward_id` in the moves Excel export (`moves-2026-09-processed.xlsx`) with Google Places Autocomplete (New): one call per address, the ward is read from the prediction text ("Ngõ 27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội"). It also writes the driving distance of each move in metres (`distance` column) with the Routes API.

A ward is written only when Google's street matches the searched street **and** the result is in Hà Nội. Addresses with no "number + street" (landmarks, buildings) are searched by place name instead, and written when Google's place name matches the address (`filled-place`: less reliable, review it). Only empty cells are filled. Everything else is left empty and listed in a report.

Claude Code instructions live in [`.claude/skills/fill-wards-google/SKILL.md`](.claude/skills/fill-wards-google/SKILL.md).

For a **raw order sheet** (the export with "Thời gian", "Điểm đón và trả hàng", "Đơn Giá", "SĐT", "Loại DV"…), `pnpm process` does the whole job in one run: see [Processing a raw order sheet](#processing-a-raw-order-sheet).

## Setup

```bash
pnpm install
cp .env.example .env    # then set GOOGLE_MAPS_API_KEY (Places API (New) and Routes API enabled)
pnpm test
```

## Usage

The workbook lives in `input/moves-2026-09-processed.xlsx`; copies taken before a run go in `input/backup/`. Save and close the workbook in Excel first.

```bash
pnpm --silent lookup --rows 4,5 --dry-run   # preview two Excel rows, nothing is written
pnpm --silent lookup --rows 4,5             # fill those rows
pnpm --silent lookup                        # whole workbook
pnpm --silent missing                       # output/dia-chi-chua-co-phuong.xlsx: empty ward cells, reason, column to fill by hand
pnpm --silent check                         # output/kiem-tra-*.xlsx: every problem in the sheet, spelling included (no API calls)
```

| Option | Default | |
|---|---|---|
| `--file <xlsx>` | `input/moves-2026-09-processed.xlsx` | Workbook with a `moves` sheet |
| `--rows <list>` | all | Excel row numbers: `4,5`, `10-50` |
| `--dry-run` | off | Look up and report without modifying the workbook |
| `--no-distance` | off | Skip the Routes API: wards only, the `distance` column is left as it is |
| `--concurrency <n>` | 5 | Parallel API calls |

A move whose pick-up or drop-off only names a disposal action ("Vứt", "Bỏ đi", "Chở Đi Vứt") is not an address: a whole-workbook run (no `--rows`, no `--dry-run`) deletes that move's row from the `moves` sheet and lists it in the console.

### Checking the sheet

`pnpm check` reads the whole `moves` sheet and Google's cached answers (no API calls) and writes `output/kiem-tra-<time>.xlsx`: sheet `chi-tiet`, one line per problem; sheet `tong-hop`, counts. Levels:

- **Lỗi**: empty or invalid ward, empty distance.
- **Nghi ngờ**: street spelt unlike Google ("Mĩ Đình" → "Mỹ Đình"); area name one letter off a known ward, old ward or district ("Từ Liên" → "Từ Liêm"); abbreviations or missing diacritics ("Ngo 139", "Đg Láng"); stuck words ("SỐ7", "16NGÕ"); distance ≤ 10 m, > 40 km, or far from the one written in `raw_text`; same origin and destination.
- **Thông tin**: spelling corrected earlier (`output/dia-chi-da-sua-*.xlsx`), manual fixes (`data/manual-overrides.json`).

### Output

- **Console:** counts per status, plus the rows that need attention.
- Each run keeps only its own report and error list in `output/` (older ones are deleted). A `--rows` run carries the other rows over from the previous report and error list, so they stay complete.
- **`output/ward-lookup-report-*.csv`:** every address with its query, status, Google address, Google ward and existing ward, plus the chosen `place_id`, its `lat`/`lng` (from the route), the move's `distance_m`, `duration` and `distance_status`.
- **`cache/places-cache.json`:** Autocomplete predictions per query (`ac:<query>`; `acplain:<query>` for the retry below). Re-runs only call the API for new queries. Requests use a Hà Nội `locationBias` and `includedRegionCodes: ["vn"]`. Older keys (`details:`, Text Search `v4:`/`v3:`/no prefix) are no longer read.
- **Retry:** when the first Autocomplete call finds nothing on the street (`street-mismatch`, `no-result`), the query is asked once more without `languageCode: vi` and without the Hà Nội bias, then (when the address had an area after the street) as the bare "number + street" ("8 Lê Quang Đạo") (with `vi`, Google drops some addresses: "54 Tây Đam, Tây Tựu, Bắc Từ Liêm" only gives "Tây Tựu, Hà Nội"). That answer is kept only when it has the searched street **and** number; the report shows its query with "(no vi)".
- **Plus codes:** an address holding a plus code ("Xrrr+jjx Tương Mai, Hà Nội") matches Google's plus code result ("XRRR+JJX Hà Nội"). That result names no ward, so the one current ward written in the address is used (`filled-place`).
- **Building and lot codes:** an address searched by place name drops its unit codes from the search text ("Tòa S3 Goldmark City" → "Goldmark City", "Số 15C1 khu đô thị Yên Hòa" → "Khu đô thị Yên Hòa", "Lk 20.16 …"); a house number in front and lot codes such as "Lk 30", "TT31", "DV 11", "NV5" go too ("16 Lk 30 khu đô thị Vân Canh" → "Khu đô thị Vân Canh"); plain numbers elsewhere ("Vinhomes Ocean Park 1") and plus codes stay. Such addresses are never read as "number + street". Abbreviations KCN, KĐT, KĐTM, KTT are spelt out when names are compared, and ward/district names are left out ("Kepler Hà Đông" ↔ "Thùy Lưu Kepler Land"). The workbook keeps the address as written.
- **Distance:** for each move whose pick-up and drop-off both got a ward from Google (`filled`, `filled-place`, `same` or `differs`), one Routes API `computeRoutes` call (`DRIVE`, `TRAFFIC_UNAWARE`: fastest route without live traffic) between the two chosen predictions by `placeId`. `distanceMeters` goes into the empty `distance` cell (an existing value is kept: `same` / `differs`). Moves with a side that got no ward are `no-point`; no route found is `no-route`. Cached as `route:<origin placeId>|<destination placeId>`.

### Statuses

| Status | Meaning |
|---|---|
| `filled` | Empty cell filled with the ward Google found |
| `filled-place` | Same, found by place name (landmark, building…): less reliable |
| `filled-area` | Same, from `data/area-wards.json`: the address names an area known to lie in one ward (Yên Xá, Tân Triều, Triều Khúc → Thanh Liệt; Vạn Phúc + Hà Đông → Hà Đông; each with a fallback `point`), whatever Google said. Its distance uses Google's point when that point is in the area too, else the rule's `point` text if any |
| `filled-single` | Same, from a call that gave a single Hà Nội prediction: taken without the street/number/name checks. Its ward must still read as one of the 126 and fit any ward or area written in the address. Not for addresses placed relative to the other one ("Nhà đối diện", "Đầu Ngõ") |
| `filled-street` | Same, from a place search that only found the whole street ("Phố Mộ Lao, Hà Đông"): Google's ward is taken when it fits any ward or area written in the address. Approximate on long streets that cross wards |
| `filled-written` | Nothing from Google fit, but the address writes its ward out ("Chung cư X20 phường Thanh Liệt", "Xã Hát Môn"): that ward is taken. Distance only when Google's point lies in that ward |
| `same` | Cell already had that ward |
| `differs` | Cell has another ward: kept, check it |
| `no-result` | Google found nothing |
| `not-hanoi` | No result in Hà Nội |
| `street-mismatch` | Results are on another street |
| `name-mismatch` | Place search: no Hà Nội result has a name matching the address |
| `bare-street` | Place search: the matching result is a whole street ("Đường Nguyễn Khang"), which crosses wards. Lower results are not tried |
| `area-mismatch` | Right street and number, but the old ward written in the address was not merged into Google's ward |
| `old-area` | Google's ward is named like an old district and the part right before it is an old ward not merged into it ("…, Trung Hoà, Cầu Giấy, Hà Nội"). When that part is itself a current ward ("…, Vĩnh Hưng, Hai Bà Trưng"), that ward is taken instead |
| `unknown-ward` | Google's ward is not in `data/wards.json` |
| `ambiguous` | Matching results point to different wards |

## Processing a raw order sheet

```bash
pnpm --silent process --cache-only                  # preview: no Google call; cache misses are temporary failures (= calls a real run needs)
pnpm --silent process --rows 2-40 --out sample.xlsx # a sample
pnpm --silent process                               # Desktop\data.xlsx → output\data_processed.xlsx
```

| Option | Default | |
|---|---|---|
| `--input <xlsx>` | `data.xlsx` on the Desktop (found through Windows, OneDrive included) | Raw order sheet; never modified |
| `--out <xlsx>` | `output/<input name>_processed.xlsx` | Refuses to be the input file; a re-run overwrites it |
| `--rows <list>` | all | Excel row numbers of the source sheet |
| `--cache-only` | off | No Google request at all |
| `--statuses <list>` | `Hoàn thành` | "Tình Trạng" values that count as a move; others go to Failed Rows |
| `--expected-years <list>` | `2026` | Any other year (after the typo fixes) is flagged |
| `--offline-schema` | off | Use the last schema read (`cache/db-schema.json`) when MySQL is down |
| `--concurrency <n>` | 5 | Parallel API calls (paced at 5 per second per API anyway) |

The output workbook has exactly four sheets:

- **Original Data**: the source sheet itself, cells and formatting untouched; its Excel row numbers are the `source_row` used everywhere else.
- **Formatted Data**: one line per source record (blank rows are not records and are listed in the summary): `result` (processed / failed) and `processed_data_row`, the date and time as written, the year fix, the local and UTC timestamps, the address as written and split into `origin_address` / `destination_address` (with the separator rule and the notes removed), price, phone and service type with the rule used for each. No Google data here.
- **Processed Data**: only records that pass every check, with exactly the columns of the `moves` table that a client supplies (read from MySQL: `moved_at` … `phone`; no `id`, `created_at`, `updated_at`, no helper column). `moved_at` is UTC. The row's source is in Formatted Data (`processed_data_row`).
- **Failed Rows**: every other record with all its original cells, `source_row`, `error_type` (permanent / temporary (retry)), every failing stage, field and reason (not only the first), and safe diagnostics (Google's answer).

Rules, in order:

1. **Date and time.** The first "Thời gian" column is the date, the second the time of day (free text). Years 2036, 2046 and 3026 are typos for 2026 (only the year changes); any other year outside `--expected-years` fails. Time: "8h", "14h30p", "15g30", "10:45"; a range keeps its start ("8h30-45p", "14-15h"); "chiều"/"tối" add 12 h; "mai" keeps the row date (as for September). The Hà Nội time is converted to UTC (−7 h, date rollover included).
2. **Addresses.** Notes are removed first (parentheses, "xbg ok", distances, "hỗ trợ…"), then the text is split on arrows (`-->`, `=>`, `—>`…), else on a label ("trả:", "điểm trả hàng"), a word ("đến", "sang", "về"…) or a dash; a label, word or dash that occurs more than once is ambiguous and fails. Several stops keep the first pick-up and last drop-off. A side that is only a distance ("—> 300m"), a missing side, or a disposal action ("chở đi vứt") fails. Each side is cleaned (abbreviations "kđt", "sn", "Ng.", "hđ" spelt out, ", Hà Nội, Việt Nam" dropped) and capitalized the Vietnamese way (names capitalized, "số / ngõ / ngách / chung cư…" lowercase, codes such as "CT1A" uppercase).
3. **Price.** Whole đồng; "1.500.000", "1,500,000", "280k", "1tr5" are read; decimals, unreadable text and anything under 10.000 đ fail.
4. **Phone.** Leading 0 restored, +84 → 0; a cell with two numbers keeps the first. A missing phone is copied **only** from the record on the row directly above when it is the same order (same pick-up and drop-off after normalization, same date); chains are followed back to the row that has it. A phone that can't be inferred stays empty (`moves.phone` is nullable); an unreadable one fails.
5. **Missing date or time.** Same rule: only from the row directly above, same order (and same date for a time, same phone for a date). Never from another order.
6. **Service type.** Explicit labels only: "Ba gác" → Ba gác, "Tải" → Xe tải, "Trọn gói" → Trọn gói; ids from the `service_types` table. Anything else fails.
7. **Order status.** Only `--statuses` (default "Hoàn thành") reach Processed Data.
8. **Wards and distance.** Each distinct address is looked up once with the `pnpm lookup` rules (`src/google.mjs`); the ward id must exist in the `wards` table, and `data/wards.json` must match that table exactly or the run stops. `data/manual-overrides.json` (September rows) is **not** used. The distance is one Routes call per distinct pair of places, in metres. Wards and distance are nullable in the table but required here. Rows that already fail before Google are not looked up (no wasted calls).
9. **Database checks.** NOT NULL, varchar lengths, int ranges, CHECK (`price`, `distance` ≥ 0), foreign keys. A record whose natural key (phone, Hà Nội day, both addresses, service type: the API's duplicate rule) is already in `moves` fails as a duplicate; two such records in the file are both kept (usually two vehicles of one move, as for September) and marked in `duplicate_of_row`.
10. **Export.** Written to a temporary file then renamed, then reopened and checked (sheet names and order, row counts, Processed Data columns and types). Nothing is ever written to MySQL.

Two files per input, both overwritten by the next run of the same input: the workbook and, next to it, `<name>_processed.log.jsonl`: the summary on the first line (also printed), then every transformation, inference and failure by source row (phones masked), then Google's answer for each address (query, status, answer, ward, place id, distance).

**Google errors** are classified: 429 (quota), 5xx, timeouts and network failures are *temporary* (retried with back-off; the row fails as "temporary (retry)", re-run later and only the missing answers are asked); 400 is *permanent*; 403 (key, API not enabled, billing) stops every further call of the run. Errors are never cached.

**Cache.** `cache/places-cache.json` keeps Google's answers; the fetch date of each is in `cache/places-cache.meta.json`, and answers older than `GOOGLE_CACHE_TTL_DAYS` (default 30, Google Maps Platform terms limit how long content may be kept; check your own agreement) are dropped and asked again. This applies to `pnpm lookup` too.

## Pushing to the database

The API project (`../hanoi-moving-insights-api`, MySQL) already has an import script. Two steps, no HTTP call:

```bash
pnpm --silent export-json        # input/*.xlsx → output/moves-db.json (only the columns of the moves table)
pnpm --silent push-db            # runs the API's "pnpm db:import-moves output/moves-db.json" with the API's .env
pnpm --silent push-db --replace  # same, deleting every existing move first
```

- **`export-json`** keeps `source_row`, `moved_at` (UTC in the sheet, `moved_at_local` is +7 h; written as ISO `…Z`), both addresses, both wards as their **official code** (through the `wards` sheet), the service type as its **name** (through `service_types`), `price`, `phone` and `distance` (metres). `raw_text` and `moved_at_local` are left out. Every record is checked with the API's rules first; on any problem nothing is written.
- **`push-db`** hands the file to the API's `db:import-moves`: it resolves codes and names to ids, validates each record like the API and inserts them all in one transaction. It refuses a non-empty `moves` table unless `--replace` is given. The API folder can be set with `MOVES_API_DIR` in `.env`.

## Data

- **`data/wards.json`:** the 126 current Hà Nội wards/communes: `id` (the value written into the cells), official `code`, `name`.
- **`data/area-wards.json`:** areas that lie wholly in one ward, applied after the Google lookup (status `filled-area`). Add a rule when you know better than Google.
- **`data/manual-overrides.json`:** fixes for single moves, by `source_row` and side, each with its reason: a `ward`, a `point` text searched for the distance (its ward is taken when no `ward` is given and the cell is empty), `sameAsOther` (the other side's ward and point: "Nhà đối diện", "Đầu Ngõ"), and a fixed `distance` in metres (from `raw_text`: "cách 300m"). Status `filled-manual`.
- **`data/ward-history.json`:** for each current ward, its official note listing the old wards merged into it (Nghị quyết 1656/NQ-UBTVQH15). `src/old-wards.mjs` turns it into old ward → current wards. 21 notes were cut at 255 characters in the source, so those wards are never rejected by the old-ward check.

## Privacy

Only the address text is sent to Google. `input/` (the workbook and its backups), `cache/` and `output/` contain customer data, and `.env` contains the API key. All four are git-ignored.
