// Truncate [s] to at most [maxLen] UTF-16 code units, backing up by 1 if the
// cut falls on the high surrogate of a pair, to avoid emitting lone surrogates.
String safeTruncate(String s, int maxLen) {
  if (maxLen <= 0) return '';
  if (s.length <= maxLen) return s;
  var end = maxLen;
  final cu = s.codeUnitAt(end - 1);
  if (cu >= 0xD800 && cu <= 0xDBFF) end--; // high surrogate: back up
  return s.substring(0, end);
}
