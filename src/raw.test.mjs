import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctYear, findColumns, formatLocal, hanoiToUtc, inferFromRowAbove, mapService, parsePhone, parsePrice, parseTime, readDate, splitAddresses } from './raw.mjs';

const OCT18 = { year: 2026, month: 10, day: 18 };
const rec = (row, fields) => ({ row, origin: '22 Chính Kinh', destination: '46B Nhân Hòa', date: OCT18, time: { hour: 10, minute: 0 }, phone: null, ...fields });

test('inferFromRowAbove: phone and time copied only from the same order on the row directly above', () => {
  const rows = [
    rec(26, { phone: '0984690410' }),
    rec(27, { phoneMissing: true, time: null, timeError: 'missing' }), // same order → phone and time
    rec(28, { phoneMissing: true }), // chain: row 27's inferred phone, traced back to row 26
    rec(29, { phoneMissing: true, destination: '15 Tràng Tiền' }), // only the pick-up matches → nothing
    rec(30, { phone: '0912345678', destination: '15 Tràng Tiền' }), // existing phone is never replaced
    rec(32, { phoneMissing: true, destination: '15 Tràng Tiền' }), // row 31 is not a record (blank): nothing
    rec(33, { phoneMissing: true, destination: '15 Tràng Tiền', date: { ...OCT18, day: 19 } }), // above is another day
  ];
  const events = [];
  inferFromRowAbove(rows, (row, name) => events.push(`${row} ${name}`));
  const [r26, r27, r28, r29, r30, r32, r33] = rows;
  assert.equal(r27.phone, '0984690410');
  assert.deepEqual(r27.time, { hour: 10, minute: 0 });
  assert.equal(r27.timestampFrom, 26);
  assert.equal(r28.phone, '0984690410');
  assert.equal(r28.phoneFrom, 26);
  assert.equal(r29.phone, null);
  assert.equal(r30.phone, '0912345678');
  assert.equal(r32.phone, null);
  assert.equal(r33.phone, null);
  assert.equal(r26.phone, '0984690410');
  assert.ok(events.includes('29 phone left empty'));
});

test('placeNameMatches: a generic shop name is not the place ("Cà Phê" ≠ "Cà phê Alasca Văn Khê")', async () => {
  const { placeNameMatches } = await import('./address.mjs');
  assert.equal(placeNameMatches('Cà Phê Alasca Văn Khê', 'Cà Phê'), false);
  assert.equal(placeNameMatches('Khách Sạn Kim Liên', 'Khách sạn Kim Liên'), true);
});

test('inferFromRowAbove: a time is never taken from another order or another day; a date needs the same phone', () => {
  const rows = [
    rec(2, { phone: '0966121716' }),
    rec(3, { destination: '1 Tràng Tiền', time: null, timeError: 'missing', phone: '0966121716' }), // other order
    rec(4, { destination: '1 Tràng Tiền', date: null, dateError: 'missing', phone: '0966121716' }), // same order as 3, same phone
    rec(5, { destination: '1 Tràng Tiền', date: null, dateError: 'missing', phone: '0900000000' }), // phones differ
  ];
  inferFromRowAbove(rows);
  assert.equal(rows[1].time, null);
  assert.equal(rows[1].timeError, 'missing');
  assert.deepEqual(rows[2].date, OCT18);
  assert.equal(rows[3].date, null);
});

test('findColumns: the first "Thời gian" is the date, the second the time', () => {
  const col = findColumns([null, 'Thời gian', 'Điểm đón và trả hàng', 'Đơn Giá', 'SĐT', 'Tình Trạng', 'Thời gian', 'Tư Vấn', 'Vận Đơn', 'Loại DV']);
  assert.deepEqual(col, { date: 2, address: 3, price: 4, phone: 5, status: 6, service: 10, time: 7 });
  assert.throws(() => findColumns(['Thời gian', 'Điểm đón và trả hàng', 'Đơn Giá', 'SĐT', 'Loại DV']), /time/);
});

test('readDate: Date cells (UTC midnight), Excel serials and text', () => {
  assert.deepEqual(readDate(new Date(Date.UTC(2026, 9, 18))).value, { year: 2026, month: 10, day: 18 });
  assert.deepEqual(readDate(46296).value, { year: 2026, month: 10, day: 1 });
  assert.deepEqual(readDate('18/10/2036').value, { year: 2036, month: 10, day: 18 });
  assert.deepEqual(readDate('2026-10-18').value, { year: 2026, month: 10, day: 18 });
  assert.equal(readDate(null).error, 'missing');
  assert.match(readDate('31/02/2026').error, /invalid/);
  assert.match(readDate('hôm qua').error, /unreadable/);
});

test('correctYear: 2036, 2046 and 3026 become 2026, other years are flagged, not corrected', () => {
  assert.deepEqual(correctYear({ year: 2036, month: 10, day: 18 }), { value: { year: 2026, month: 10, day: 18 }, corrected: { from: 2036, to: 2026 } });
  assert.deepEqual(correctYear({ year: 2046, month: 10, day: 18 }).value, { year: 2026, month: 10, day: 18 });
  assert.deepEqual(correctYear({ year: 3026, month: 10, day: 1 }).value, { year: 2026, month: 10, day: 1 });
  assert.deepEqual(correctYear({ year: 2026, month: 10, day: 18 }), { value: { year: 2026, month: 10, day: 18 } });
  assert.match(correctYear({ year: 2025, month: 12, day: 31 }).error, /suspicious year 2025/);
  assert.match(correctYear({ year: 2027, month: 1, day: 1 }).error, /suspicious year 2027/);
});

test('parseTime: hours, minutes, ranges (start), afternoon words, notes', () => {
  const t = (s) => parseTime(s).value;
  assert.deepEqual(t('14h'), { hour: 14, minute: 0 });
  assert.deepEqual(t('8h30-45p sáng '), { hour: 8, minute: 30 });
  assert.deepEqual(t('14-15h '), { hour: 14, minute: 0 });
  assert.deepEqual(t('16h30-17h'), { hour: 16, minute: 30 });
  assert.deepEqual(t('9h-9h15'), { hour: 9, minute: 0 });
  assert.deepEqual(t('7h tối'), { hour: 19, minute: 0 });
  assert.deepEqual(t('13h chiều'), { hour: 13, minute: 0 });
  assert.deepEqual(t('10:45'), { hour: 10, minute: 45 });
  assert.deepEqual(t('12h20( tải 5 tạ)'), { hour: 12, minute: 20 });
  assert.equal(parseTime('14-15h').rule, 'range start');
  assert.match(parseTime('8h sáng mai').notes[0], /mai/);
  assert.equal(parseTime('').error, 'missing');
  assert.equal(parseTime('báo sau').error, 'missing');
  assert.match(parseTime('25h').error, /invalid/);
});

test('hanoiToUtc: −7 h with date rollover, applied once', () => {
  assert.equal(hanoiToUtc({ year: 2026, month: 10, day: 18 }, { hour: 3, minute: 0 }).toISOString(), '2026-10-17T20:00:00.000Z');
  assert.equal(hanoiToUtc({ year: 2026, month: 10, day: 18 }, { hour: 15, minute: 30 }).toISOString(), '2026-10-18T08:30:00.000Z');
  assert.equal(hanoiToUtc({ year: 2026, month: 1, day: 1 }, { hour: 0, minute: 0 }).toISOString(), '2025-12-31T17:00:00.000Z');
  // The year typo is fixed before the conversion: "18/10/2036 15:30" → 2026-10-18 08:30 UTC
  const date = correctYear(readDate('18/10/2036').value).value;
  assert.equal(hanoiToUtc(date, parseTime('15h30').value).toISOString(), '2026-10-18T08:30:00.000Z');
  assert.equal(formatLocal(date, { hour: 15, minute: 30 }), '2026-10-18 15:30');
});

test('parsePrice: whole đồng, separators, k / tr shorthand; nothing rounded or guessed', () => {
  assert.equal(parsePrice(270000).value, 270000);
  assert.equal(parsePrice('200.000').value, 200000);
  assert.equal(parsePrice('1,500,000').value, 1500000);
  assert.equal(parsePrice('1 500 000 đ').value, 1500000);
  assert.equal(parsePrice('280k').value, 280000);
  assert.equal(parsePrice('3tr2').value, 3200000);
  assert.equal(parsePrice('1tr5 ').value, 1500000);
  assert.equal(parsePrice('1tr').value, 1000000);
  assert.equal(parsePrice('1tr25').value, 1250000);
  assert.match(parsePrice('200.50').error, /unreadable/);
  assert.match(parsePrice(200.5).error, /whole number/);
  assert.match(parsePrice(200).error, /implausibly low/);
  assert.match(parsePrice(2000).error, /implausibly low/);
  assert.equal(parsePrice(null).error, 'missing');
});

test('parsePhone: leading zero, +84, two numbers keep the first, invalid numbers rejected', () => {
  assert.deepEqual(parsePhone('0966121716'), { value: '0966121716', rule: 'as entered', notes: [] });
  assert.equal(parsePhone(344736631).value, '0344736631');
  assert.equal(parsePhone(84912442002).value, '0912442002');
  assert.equal(parsePhone('0888 399 836').value, '0888399836');
  assert.equal(parsePhone('0948.588.526').value, '0948588526');
  assert.equal(parsePhone('đón: 0984187052 - trả: 0364644518').value, '0984187052');
  assert.equal(parsePhone('0977209776 => 0394141111').rule, 'first of two');
  assert.match(parsePhone('039186257').error, /phone/);
  assert.equal(parsePhone(null).error, 'missing');
});

test('mapService: explicit labels only, ids from the database', () => {
  const ids = new Map([['Ba gác', 1], ['Xe tải', 2], ['Trọn gói', 3]]);
  assert.deepEqual(mapService('Ba gác', ids).value, { id: 1, name: 'Ba gác' });
  assert.deepEqual(mapService('Tải', ids).value, { id: 2, name: 'Xe tải' });
  assert.deepEqual(mapService(' trọn gói ', ids).value, { id: 3, name: 'Trọn gói' });
  assert.match(mapService('Xe cẩu', ids).error, /unknown service type/);
  assert.match(mapService('Tải', new Map([['Ba gác', 1]])).error, /not in the service_types table/);
});

test('splitAddresses: arrows, words, labels; notes removed but kept; Vietnamese capitalization', () => {
  const s = (t) => { const r = splitAddresses(t); return r.error ? r.error : [r.origin, r.destination, r.rule]; };
  assert.deepEqual(s('ngõ 185 chùa láng --> ngõ 225 quan hoa '), ['Ngõ 185 Chùa Láng', 'Ngõ 225 Quan Hoa', 'arrow']);
  assert.deepEqual(s('67 thái thịnh đến 74 văn phúc hà đông'), ['67 Thái Thịnh', '74 Văn Phúc Hà Đông', 'word']);
  assert.deepEqual(s(' 93 hoàng quốc việt---> 15C1 KĐT Yên Hòa, Cầu Giấy'), ['93 Hoàng Quốc Việt', '15C1 khu đô thị Yên Hòa, Cầu Giấy', 'arrow']);
  assert.deepEqual(s('Đón tại: 9 ngõ 61 yên hòa. Trả tại: 84 ngõ 59 khúc thừa dụ')[1], '84, ngõ 59 Khúc Thừa Dụ');
  assert.deepEqual(s('316 Trần Cung về, 41 Ngõ 63 Trần Quốc Vượng'), ['316 Trần Cung', '41, ngõ 63 Trần Quốc Vượng', 'word']);
  assert.deepEqual(s('63Trần Quốc Vượng sang 59 Phạm Văn Đồng')[0], '63 Trần Quốc Vượng');
  // Arrows inside a parenthesised note do not split; the note is reported as removed
  const r = splitAddresses('89/2/51 lạc long quân về 8 ngõ 12/93 chính kinh. 8km ( t2-t4/xbg ok )/ dự trù xe kéo tay');
  assert.deepEqual([r.origin, r.destination], ['89/2/51 Lạc Long Quân', '8, ngõ 12/93 Chính Kinh']);
  assert.deepEqual(r.removed, ['( t2-t4/xbg ok )', '8km', '/ dự trù xe kéo tay']);
  assert.match(s('park 11 times city ( t28 -->t2 trong 1 tòa )\n'), /only one address/);
  // Several stops: first pick-up, last drop-off (rule decided for the September file)
  const multi = splitAddresses('đón : 4 chu văn an ---> trả 1: số 1 nguyễn lam phúc lợi hà nội ---> trả 2 :  70 đại lộ bốn mùa');
  assert.equal(multi.origin, '4 Chu Văn An');
  assert.equal(multi.destination, '70 Đại Lộ Bốn Mùa');
  assert.match(multi.notes[0], /3 stops/);
});

test('splitAddresses: unconfident splits are errors, not guesses', () => {
  assert.match(splitAddresses('472 lạc long quân').error, /only one address/);
  assert.match(splitAddresses('Số 30 ngách 6/12 đội nhân—> 300m ( t2-t3/xbg ok )').error, /only a distance/);
  assert.match(splitAddresses('20 sunrise D , KDT The Manor Nguyễn Xiển --->500m').error, /drop-off address is missing/);
  assert.match(splitAddresses('261 Trần Quốc Hoàn - Chung Cư Nam Xa La - Phúc La Hà Đông').error, /ambiguous split/);
  assert.equal(splitAddresses(null).error, 'missing address');
});
