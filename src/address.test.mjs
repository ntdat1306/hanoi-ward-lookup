import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { areaWardCodes, buildOldWardIndex, oldWardNames } from './old-wards.mjs';
import { addressHasNumberAndStreet, buildQuery, isBareStreet, placeSearchText, sameStreetSpelling, isDisposalAddress, parseFormattedAddress, placeNameMatches, streetsMatch, wardKey } from './address.mjs';

test('buildQuery keeps "<lane or house number> <street>"', () => {
  const cases = {
    'Số nhà 49, ngõ 27 Đại Cồ Việt': '27 Đại Cồ Việt',
    '201/4 Đê Tô Hoàng': '201 Đê Tô Hoàng',
    '18, ngõ 259 Yên Hòa': '259 Yên Hòa',
    '19, ngõ 143 Quan Hoa': '143 Quan Hoa',
    'Số 16, ngách 113, ngõ 43 Trung Kính': '43 Trung Kính',
    '11/61/1002 Láng': '1002 Láng',
    'Số nhà 22A, ngách 103, ngõ 1194 đường Láng, phường Láng': '1194 Láng, phường Láng',
    '23 Quang Trung Hà Đông': '23 Quang Trung Hà Đông',
    '23 Quang Trung, Hà Đông': '23 Quang Trung, Hà Đông',
    '23 Quang Trung, Cửa Nam, Hà Nội': '23 Quang Trung, Cửa Nam',
    '141 An Dương Vương': '141 An Dương Vương',
    'Số 2 dãy C, ngõ 6 Ngô Quyền, Quang Trung, Hà Đông': '6 Ngô Quyền, Quang Trung, Hà Đông',
    '843 Quang Trung Hà Đông': '843 Quang Trung Hà Đông',
    'Số 3, ngõ 138/58 Tân Triều': '138 Tân Triều',
    'Ngõ 21/50 Yên Xá': '21 Yên Xá',
    'Ngách 99/110/67 Định Công Hạ': '99 Định Công Hạ',
    'Hẻm 12 Trần Phú': '12 Trần Phú',
    'Số 5, hẻm 20/8 Lạc Long Quân': '20 Lạc Long Quân',
    'Ngõ 32, ngách 101, hẻm 9 số nhà 21 Đỗ Đức Dục': '32 Đỗ Đức Dục',
    'Ngõ 734, ngách 26, hẻm 28 nhà số 1 Kim Giang': '734 Kim Giang',
    'Hẻm 101 Gốc Đề / 7B': '101 Gốc Đề', // "Gốc Đề" is the lane itself; "/ 7B" is dropped
    'Ngách 55 Lạc Trung / Khu B': '55 Lạc Trung',
    '279 Đội Cấn': '279 Đội Cấn',
    'Số nhà 12A 230/21/15 Mễ Trì Thượng': '230 Mễ Trì Thượng',
    'Nhà số 6 167 phố Quang Tiến': '167 Quang Tiến',
    'Số 3 Lương Yên': '3 Lương Yên',
  };
  for (const [address, query] of Object.entries(cases)) assert.equal(buildQuery(address)?.query, query, address);
});

test('buildQuery returns null when there is no number + street', () => {
  for (const address of ['Ga Hà Nội', 'Vinhomes Ocean Park 1', 'Ngách 87, ngõ Văn Hương', 'Tòa CT4 The Pride', '12 đội 5', null]) {
    assert.equal(buildQuery(address), null, String(address));
  }
});

test('parseFormattedAddress reads street, ward and city', () => {
  assert.deepEqual(parseFormattedAddress('Ng. 27 Đ. Đại Cồ Việt, Bạch Mai, Hà Nội, Vietnam'), {
    street: 'Đại Cồ Việt', ward: 'Bạch Mai', isHanoi: true, numbers: ['27'], area: 'Ng. 27 Đ. Đại Cồ Việt',
  });
  assert.deepEqual(parseFormattedAddress('143 Phố Quan Hoa, Nghĩa Đô, Hà Nội, Vietnam'), {
    street: 'Quan Hoa', ward: 'Nghĩa Đô', isHanoi: true, numbers: ['143'], area: '143 Phố Quan Hoa',
  });
  assert.deepEqual(parseFormattedAddress('Ng. 259 P. Yên Hòa, Yên Hòa, Hà Nội, Vietnam'), {
    street: 'Yên Hòa', ward: 'Yên Hòa', isHanoi: true, numbers: ['259'], area: 'Ng. 259 P. Yên Hòa',
  });
  assert.deepEqual(parseFormattedAddress('Chung cư Goldseason, 47 Đ. Nguyễn Tuân, Thanh Xuân, Hà Nội'), {
    street: 'Nguyễn Tuân', ward: 'Thanh Xuân', isHanoi: true, numbers: ['47'], area: 'Chung cư Goldseason, 47 Đ. Nguyễn Tuân',
  });
  assert.equal(parseFormattedAddress('12 Lê Lợi, Bến Thành, Hồ Chí Minh, Vietnam').isHanoi, false);
  // Autocomplete without languageCode vi mixes unaccented names
  const plain = parseFormattedAddress('54 Phố Tây Đam, TDP Thượng 4, Tay Tuu, Tây Tựu, Ha Noi, Vietnam');
  assert.equal(plain.isHanoi, true);
  assert.equal(plain.ward, 'Tây Tựu');
  assert.equal(plain.street, 'Tây Đam');
  // Country written in full; plus code stuck to the city
  assert.equal(parseFormattedAddress('45 Phố Vĩnh Hồ, Đống Đa, Hà Nội, Socialist Republic of Vietnam').ward, 'Đống Đa');
  assert.equal(parseFormattedAddress('XRRR+JJX Hà Nội').isHanoi, true);
  assert.equal(parseFormattedAddress('Tổ 1/24 Phố Ngọc Trục, làng Ngọc Trục, Đại Mỗ, Hà Nội').street, 'Ngọc Trục');
  assert.equal(parseFormattedAddress('Phố Trần Quý Kiên/44 Phố Dịch Vọng, Cầu Giấy, Hà Nội').street, 'Dịch Vọng');
  assert.equal(parseFormattedAddress('28/132a Phố Đại Linh, Đại Mỗ, Hà Nội').street, 'Đại Linh');
});

test('streetsMatch tolerates old area names after the street, nothing else', () => {
  assert.ok(streetsMatch('Đại Cồ Việt', 'Đại Cồ Việt'));
  assert.ok(streetsMatch('Yên Hoà', 'Yên Hòa'));
  assert.ok(streetsMatch('Quang Trung Hà Đông', 'Quang Trung'));
  assert.ok(streetsMatch('Xuân Đỉnh- Phường Xuân Đỉnh', 'Xuân Đỉnh'));
  assert.ok(streetsMatch('Trần Điền-lê Trọng Tấn', 'Trần Điền'));
  assert.ok(!streetsMatch('Quang Trung', 'Đàm Quang Trung'));
  assert.ok(!streetsMatch('Yên Hòa', 'Yên Hòa Garden'));
  assert.ok(streetsMatch('Gốc Đề', 'Ngõ Gốc Đề'));
  assert.ok(streetsMatch('Mĩ Đình', 'Mỹ Đình'));
  assert.ok(streetsMatch('Đê Nguyễn Khoái', 'Nguyễn Khoái'));
  assert.ok(streetsMatch('Đê Tô Hoàng', 'Đê Tô Hoàng'));
  assert.ok(!streetsMatch('Quyền', 'Ngô Quyền'));
  assert.ok(sameStreetSpelling('Đông Quan', '- Đông Quan'));
  assert.ok(!sameStreetSpelling('Đông Quan', 'Đồng Quan'));
  assert.ok(sameStreetSpelling('Yên Hoà', 'Yên Hòa'));
  assert.ok(sameStreetSpelling('Ngọc Thuỵ', 'Ngọc Thụy'));
});

test('placeNameMatches needs most of Google\'s place name in the address', () => {
  assert.ok(placeNameMatches('Bến xe Nước Ngầm', 'Bến xe Nước Ngầm'));
  assert.ok(placeNameMatches('Bể bơi Thuỷ Lợi', 'Bể bơi Đại học Thủy Lợi'));
  assert.ok(placeNameMatches('Sảnh B Tòa Vinaconex 1 Khuất Duy Tiến', 'Vinaconex 1'));
  assert.ok(placeNameMatches('Học Viện Cảnh Sát', 'Học viện Cảnh sát nhân dân (T02) Bộ Công an'));
  assert.ok(placeNameMatches('Cây xăng Thành Nam, Thạch Hòa, Thạch Thất', 'Trạm Xăng Dầu Thành Nam'));
  assert.ok(!placeNameMatches('Sảnh B Tòa Vinaconex 1 Khuất Duy Tiến', 'Vinaconex 2'));
  assert.ok(!placeNameMatches('Số 98', 'Nhà hàng 98'));
  assert.ok(!placeNameMatches('Nhà thờ Trung Văn', 'Trường THCS Đại Mỗ'));
});

test('addressHasNumberAndStreet needs one of Google\'s numbers right before its street', () => {
  assert.ok(addressHasNumberAndStreet('Chung cư Sictech 304 Hồ Tùng Mậu', ['304'], ['Hồ Tùng Mậu']));
  assert.ok(addressHasNumberAndStreet('TQ Building 286 đường Nguyễn Xiển, Thanh Xuân', ['286'], ['Nguyễn Xiển']));
  assert.ok(!addressHasNumberAndStreet('Chung cư Sictech 304 Hồ Tùng Mậu', ['30'], ['Hồ Tùng Mậu']));
  assert.ok(!addressHasNumberAndStreet('Chung cư Sictech 304 Hồ Tùng Mậu', ['304'], ['Xuân Thủy']));
  assert.ok(!addressHasNumberAndStreet('Tòa B 304 Đàm Quang Trung', ['304'], ['Quang Trung']));
  assert.ok(!addressHasNumberAndStreet('Vinhomes Ocean Park 1', [], ['Ocean Park']));
});

test('old wards map to the wards they were merged into', () => {
  const rows = [
    { code: '00367', name: 'Phường Thanh Xuân', note: 'Đổi tên từ phường Thanh Xuân Bắc thành phường Thanh Xuân, hợp nhất 1 phần phường Nhân Chính, 1 phần phường Trung Văn. Bỏ cấp huyện' },
    { code: '09886', name: 'Phường Dương Nội', note: 'Hợp nhất 1 phần phường Dương Nội, 1 phần phường La Khê. Bỏ cấp huyện' },
    { code: '09556', name: 'Phường Hà Đông', note: 'Đổi tên từ phường Hà Cầu thành phường Hà Đông, hợp nhất phường Vạn Phúc, 1 phần phường La Khê. Bỏ cấp huyện' },
    { code: '00433', name: 'Xã Nội Bài', note: 'Đổi tên xã Thanh Xuân thành xã Nội Bài, hợp nhất xã Phú Cường thuộc huyện Sóc Sơn (trước khi thực hiện sắp xếp) và xã Hiền Ninh. Bỏ cấp huyện' },
  ];
  assert.deepEqual(oldWardNames(rows[3].note), ['Thanh Xuân', 'Phú Cường', 'Hiền Ninh']);
  assert.deepEqual(oldWardNames(`Hợp nhất phường A, 1 phần phường Bc, 1 phần phường C${'x'.repeat(220)}. Bỏ cấp huyện`), ['A', 'Bc']);
  const index = buildOldWardIndex(rows);
  assert.deepEqual([...areaWardCodes(index, '45 Lê Trọng Tấn La Khê', 'Lê Trọng Tấn')].sort(), ['09556', '09886']);
  assert.deepEqual([...areaWardCodes(index, '50 Vũ Hữu, Nhân Chính', 'Vũ Hữu')], ['00367']);
  // old district names are not wards ("Thanh Xuân" is not xã Thanh Xuân, now Nội Bài); the street itself is skipped
  assert.equal(areaWardCodes(index, '34 Nguyễn Văn Trỗi Thanh Xuân', 'Nguyễn Văn Trỗi'), null);
  assert.equal(areaWardCodes(index, '77 Vạn Phúc', 'Vạn Phúc'), null);
  // diacritics count: "Làng" is not phường Láng; unit words are dropped
  const lang = buildOldWardIndex([{ code: '00199', name: 'Phường Láng', note: 'Hợp nhất phường Láng Thượng. Bỏ cấp huyện' },
    { code: '00316', name: 'Phường Định Công', note: 'Hợp nhất 1 phần phường Định Công. Bỏ cấp huyện' },
    { code: '00999', name: 'Xã Phương Đình', note: 'Hợp nhất xã Phương Đình. Bỏ cấp huyện' }]);
  assert.equal(areaWardCodes(lang, 'Cổng Làng Ngõ 52 đường Mỹ Đình', 'Mỹ Đình'), null);
  assert.deepEqual([...areaWardCodes(lang, '200 Trần Điền, phường Định Công', 'Trần Điền')], ['00316']);
  assert.deepEqual([...areaWardCodes(index, '22 Đồng Cổ, Thuỵ Khuê', 'Đồng Cổ') ?? []], []);
  assert.deepEqual(oldWardNames('Hợp nhất phường Cầu Diễn, một phần diện tích tự nhiên, quy mô dân số của phường Mễ Trì. Bỏ cấp huyện'), ['Cầu Diễn', 'Mễ Trì']);
});

test('isDisposalAddress spots addresses that only name a disposal action', () => {
  for (const a of ['Vứt', 'Bỏ đi', 'Chở Đi Vứt', 'Chở Đi Bỏ', 'đổ rác', 'Thanh lý']) assert.ok(isDisposalAddress(a), a);
  for (const a of ['Bộ Công An', 'Chở đi', 'Bờ Hồ', '12 Đồ Sơn', 'Vứt ở 12 Láng', '', null]) assert.ok(!isDisposalAddress(a), String(a));
});

test('wardKey ignores the unit prefix and diacritics', () => {
  assert.equal(wardKey('Phường Bạch Mai'), wardKey('Bạch Mai'));
  assert.equal(wardKey('Xã Sóc Sơn'), 'soc son');
});

test('googleWardFits rejects an old ward in the Google text that was not merged into its ward', async () => {
  const { googleWardFits, loadOldWardIndex } = await import('./old-wards.mjs');
  const index = loadOldWardIndex();
  const wards = JSON.parse(readFileSync(new URL('../data/wards.json', import.meta.url), 'utf8'));
  const code = (name) => wards.find((w) => w.name.endsWith(` ${name}`)).code;
  const fits = (text, street) => {
    const f = parseFormattedAddress(text);
    return googleWardFits(index, f.area, street, code(f.ward), f.ward);
  };
  assert.equal(fits('27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội', 'Đại Cồ Việt'), true);
  assert.equal(fits('595 Đường Lĩnh Nam, Vĩnh Hưng, Hai Bà Trưng, Hà Nội', 'Lĩnh Nam'), false);
  assert.equal(fits('426 Đường Láng, Đống Đa, Hà Nội', 'Láng'), true);
  assert.equal(fits('6 Ngô Quyền, Hà Đông, Hà Nội', 'Ngô Quyền'), true);
});

test('placeNameMatches rejects Autocomplete look-alikes', () => {
  assert.ok(!placeNameMatches('Khu tập thể nhà Hát Chèo Mai Dịc', 'Khu tập thể'));
  assert.ok(!placeNameMatches('Tổ 6 Phúc Đồng, Long Biên', '6 Phố Hoa Động'));
  assert.ok(!placeNameMatches('Ngõ 28/132A /21 Đại Linh', '28/132a Ngõ 21 Đại Từ'));
  assert.ok(!placeNameMatches('Oceanpack 1, Đa Tốn', '1 Phố Thạch Đà'));
  assert.ok(!placeNameMatches('Xe 2: CTI1-1A Vĩnh Hoàng Hoàng Mai', '1 Đường Vĩnh Hoàng'));
  assert.ok(placeNameMatches('Park City', 'Park City Hà Nội'));
  assert.ok(placeNameMatches('Bến xe Mỹ Đình', 'Bến xe Mỹ Đình'));
  assert.ok(placeNameMatches('B04-L09 An Phú Shop Villa, Dương Nội', 'An Phú Shop Villa'));
  assert.ok(!placeNameMatches('Khu đô thị mới Hạ Đình', 'Khu Đô Thị Mới'));
  assert.ok(!placeNameMatches('Đằng Sau đối diện Viện K', 'Bệnh viện K'));
  assert.ok(placeNameMatches('Chung cư Westpoint', 'Vinhomes Westpoint W2'));
  assert.ok(!placeNameMatches('Khu tập thể Nhà hát Chèo, Mai Dịch', 'Khu tập thể'));
  assert.ok(placeNameMatches('Khu đô thị Dương Nội 2', 'Khu đô thị dương nội 2'));
  assert.ok(placeNameMatches('Feliz Home Tòa Zen A', 'Feliz Homes - Zen Tower'));
  assert.ok(placeNameMatches('Tòa A Imperia 423 Minh Khai', 'Imperia Sky Garden'));
  assert.ok(!placeNameMatches('CT7F Dương Nội 2', '11/Đường Yên Nội/2 Ngách 16/16'));
  assert.ok(placeNameMatches('Khu Công Nghiệp Vĩnh Tuy', 'CT KCN Vĩnh Tuy'));
});

test('isBareStreet: a street prediction without a number', () => {
  assert.ok(isBareStreet('Đường Nguyễn Xiển'));
  assert.ok(isBareStreet('Phố Đỗ Nhuận'));
  assert.ok(!isBareStreet('Ngõ 200 Đường 422B'));
  assert.ok(!isBareStreet('Bến xe Mỹ Đình'));
});

test('placeSearchText drops building and lot codes, keeps plain numbers and plus codes', () => {
  assert.equal(placeSearchText('Tòa S3 Goldmark City'), 'Goldmark City');
  assert.equal(placeSearchText('Số 15C1 khu đô thị Yên Hòa, Cầu Giấy'), 'Khu đô thị Yên Hòa, Cầu Giấy');
  assert.equal(placeSearchText('Lk 20.16 khu đô thị Hinode Hoài Đức'), 'Khu đô thị Hinode Hoài Đức');
  assert.equal(placeSearchText('Tòa W3 tầng 28 chung cư Westpoint'), 'Chung cư Westpoint');
  assert.equal(placeSearchText('Vinhomes Ocean Park 1, Gia Lâm'), 'Vinhomes Ocean Park 1, Gia Lâm');
  assert.equal(placeSearchText('Phố 8-3'), 'Phố 8-3');
  assert.equal(placeSearchText('2P8W+W54, Xuân Phương'), '2P8W+W54, Xuân Phương');
});

test('buildQuery: a lot or building code is not a street', () => {
  assert.equal(buildQuery('16 Lk 30 khu đô thị Vân Canh'), null);
  assert.equal(buildQuery('Số 2 TT31 khu đô thị Văn Phú'), null);
  assert.equal(buildQuery('Số 108 A5, tập thể Vĩnh Hồ'), null);
  assert.equal(buildQuery('141 An Dương Vương').query, '141 An Dương Vương');
});

test('buildQuery drops a house number written between the lane and the street', () => {
  assert.equal(buildQuery('Ngõ 8 số 75 Lê Quang Đạo').query, '8 Lê Quang Đạo');
  assert.equal(buildQuery('Ngách 44 số 6 Trung Kính').query, '44 Trung Kính');
  assert.equal(buildQuery('84/63/30 nhà số 2 Lê Đức Thọ').query, '84 Lê Đức Thọ');
});
