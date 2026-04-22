import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';

import 'package:finance_app/finance_oracle_app.dart';

void main() {
  testWidgets('renders the cross-platform market dashboard', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 960));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(const FinanceOracleApp());
    await tester.pumpAndSettle();

    expect(find.text('Finance Oracle'), findsOneWidget);
    expect(find.text('Market Radar'), findsWidgets);

    await tester.tap(find.text('Opportunity Board').first);
    await tester.pumpAndSettle();

    expect(find.text('NVDA'), findsOneWidget);
  });
}
