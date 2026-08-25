import 'package:ag_ui/ag_ui.dart';
import 'package:test/test.dart';

void main() {
  group('AG-UI SDK', () {
    test('has correct version', () {
      expect(agUiVersion, '0.3.0');
    });

    test('can initialize', () {
      expect(initAgUI, returnsNormally);
    });
  });
}
