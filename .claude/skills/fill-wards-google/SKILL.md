---
name: fill-wards-google
description: Fill origin_ward_id / destination_ward_id in the Hanoi moves Excel export (input/moves-2026-09-processed.xlsx in this project) by looking addresses up with Google Places Autocomplete (New), one call per address. Use when the user asks to find, map, look up or fill the ward (phường/xã) of pick-up or drop-off addresses with Google Maps, or to check rows of that workbook.
---

# Fill wards with Google Places

The workbook has this sheet:
- `moves`: one move per row. Columns: `source_row`, `moved_at`, `origin_address`, `destination_address`, `origin_ward_id`, `destination_ward_id`, `service_type_id`, `distance`, `price`, `phone`, `moved_at_local`, `raw_text`.

The 126 current Hanoi wards/communes (`id`, `code`, `name`) are in `data/wards.json`; ward cells must hold the `id`, not the code. `data/ward-history.json` lists the old wards merged into each one.

The script `src/lookup-wards.mjs` does all the work. Run it; don't re-implement the lookup by hand. Its Google logic lives in `src/google.mjs`, shared with `pnpm process`.

For a **raw order sheet** (data.xlsx on the Desktop: "Thời gian", "Điểm đón và trả hàng", "Đơn Giá", "SĐT", "Loại DV"), use `pnpm process` instead (README, "Processing a raw order sheet"): it splits, normalizes, looks wards and distances up with the same rules and writes the 4-sheet review workbook. Run `pnpm --silent process --cache-only` first and tell the user how many calls the real run needs (`cacheMisses`).

## How a ward is found

1. **Build the query.** It is "<lane or house number> <street>", taken from the address:
   - "Số nhà 49, ngõ 27 Đại Cồ Việt" → `27 Đại Cồ Việt`
   - "201/4 Đê Tô Hoàng" → `4 Đê Tô Hoàng` (in slash notation, the last number is the lane on the street)
   - "11/61/1002 Láng" → `1002 Láng`
   - "141 An Dương Vương" → `141 An Dương Vương`

   Addresses without a number + street (landmarks, buildings, "ngõ Văn Hương") are searched by place name instead: the whole address (+ ", Hà Nội") is sent, and the best-ranked Hà Nội result whose `displayName` shares most words with the address gives the ward (`filled-place`, less reliable — the user accepted this; otherwise `name-mismatch`).
2. **Search.** Call Places Autocomplete (New) once with only that text, biased to a Hà Nội rectangle (`locationBias`, `includedRegionCodes: ["vn"]`). The ward is the part of the prediction text before "Hà Nội". Responses are cached in `cache/places-cache.json` (`ac:` keys), so repeated runs cost nothing.
3. **Accept a result only if BOTH are true:**
   - Google's street equals the searched street. Old area names typed after the street are tolerated: "Quang Trung Hà Đông" matches "Quang Trung". Anything else is `street-mismatch`; for example "Quang Trung" vs "Đàm Quang Trung" does not match.
   - The result is in Hà Nội (otherwise `not-hanoi`).
4. **Read the ward.** It is the component right before "Hà Nội" in `formattedAddress` ("Ng. 27 Đ. Đại Cồ Việt, **Bạch Mai**, Hà Nội"), or `administrative_area_level_2` from `addressComponents` when that is not a known ward (Google drops the ward from `formattedAddress` when it is named like the street: "1035 Hồng Hà, Hà Nội"). It is mapped to `data/wards.json` by name. Unknown names → `unknown-ward`; several different wards → `ambiguous`. When the address names an old ward next to the street ("45 Lê Trọng Tấn La Khê", "50 Vũ Hữu, Nhân Chính"), Google's ward must be one that old ward was merged into, otherwise `area-mismatch`.
5. **Write.** Only **empty** cells are written (`filled`). A cell that already holds the same ward is `same`. A cell that holds another ward is **kept** and reported as `differs`, because the user's own values are never overwritten.
6. **Distance.** When both sides of a move got a ward from Google, call Routes API `computeRoutes` (`DRIVE`, `TRAFFIC_UNAWARE`) between the two chosen predictions by `placeId`, and write `distanceMeters` (metres) into the empty `distance` cell. The route's leg gives the lat/lng of both points (report CSV). Cached as `route:` keys.

Every non-accepted case is left empty and listed. Never guess a ward the script did not accept. If the user wants a guess, they decide it.

## Workflow

1. **Check the workbook is closed in Excel.** Writing fails with EBUSY otherwise. Ask the user to save and close it first, because unsaved Excel edits would be lost.
2. **Dry run first** on the rows the user cares about. `--rows` takes Excel row numbers, e.g. `4,5` or `10-50`:
   ```bash
   pnpm --silent lookup --rows 4,5 --dry-run
   ```
3. **Show the user** what would be filled and what was rejected, then run without `--dry-run` once they agree:
   ```bash
   pnpm --silent lookup --rows 4,5          # selected rows
   pnpm --silent lookup                     # whole workbook (≈3,400 addresses; check the API quota first)
   ```
4. **Report back** from the console summary and the CSV in `output/` (opens in Excel):
   - counts per status;
   - every `differs` row (Google ward vs. kept value);
   - how many were `filled-place` (found by place name, worth a spot check);
   - the rows left empty, grouped by reason: `no-result`, `not-hanoi`, `street-mismatch`, `name-mismatch`, `unknown-ward`, `ambiguous`. Include the address and what Google returned, so the user can fill them by hand.

## Rules

- **Referring to rows:** give both numbers, "Excel row 495 (source_row 498)". `source_row` is the row in the original `moving-data.xlsx`; the Excel row is the row in this workbook.
- **Disposal "addresses":** a move whose pick-up or drop-off is only a disposal action ("Vứt", "Bỏ đi", "Chở Đi Vứt" — `isDisposalAddress`) is deleted from the `moves` sheet on a whole-workbook run, as the user asked. Report the deleted rows (Excel row + source_row).
- **Edit in place:** edit the existing workbook. Never regenerate it, because the user fills cells by hand between runs.
- **Privacy:** send only the address text to Google. Never phone numbers, names or other row data. `cache/` and `output/` hold customer addresses and are git-ignored.
- **API key:** it lives in `.env` (`GOOGLE_MAPS_API_KEY`). Never print it, commit it or paste it into reports.
- **Errors:**
  - `403`: the key is not allowed to use Places API (New).
  - `429`: quota exceeded. Wait, or lower `--concurrency`.
  - EBUSY / EPERM: the workbook is open in Excel.
- **Changing the matching rules:** they live in `src/address.mjs`. Add a case to `src/address.test.mjs`, run `pnpm test`, and only then run the lookup.
