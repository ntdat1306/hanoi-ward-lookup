// Vietnamese explanation of each lookup status, for the Excel exports (error rows, addresses to fill by hand).

export const WARD_REASON = {
  'street-mismatch': 'Google trả về đường khác, hoặc cùng đường nhưng số nhà/ngõ không trùng',
  'name-mismatch': 'Không tách được số + tên đường; tìm theo tên địa điểm nhưng tên Google trả về không khớp',
  'bare-street': 'Chỉ tìm thấy cả con đường (không có số nhà): đường dài qua nhiều phường nên không xác định được phường',
  'area-mismatch': 'Đúng đường và số, nhưng phường Google trả về không khớp phường cũ ghi trong địa chỉ',
  'old-area': 'Kết quả của Google ghi phường cũ không sáp nhập vào phường nó trả về: không chắc chắn',
  'unknown-ward': 'Google không trả về tên phường, hoặc tên phường không có trong danh sách 126 phường/xã',
  'not-hanoi': 'Google chỉ tìm thấy địa chỉ ngoài Hà Nội',
  'no-result': 'Google không tìm thấy gì',
  ambiguous: 'Kết quả rơi vào nhiều phường khác nhau',
};

export const DISTANCE_REASON = {
  'no-point': 'Chưa xác định được điểm đi và/hoặc điểm đến (xem lỗi phường), nên không tính được quãng đường',
  'no-route': 'Google không tìm được đường ô tô giữa hai điểm',
};
