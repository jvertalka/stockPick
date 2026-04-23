import 'package:flutter_test/flutter_test.dart';

import 'package:finance_app/src/models/portfolio_models.dart';

void main() {
  test('parses Fidelity-style position CSV with total cost basis', () {
    final result = parsePortfolioHoldingsCsv(
      'Symbol,Quantity,Cost Basis Total\n'
      'NVDA,2,"\$1,640.20"\n'
      'MSFT,5,"\$2,050.00"\n'
      'BROKEN,--,""\n',
      importedAt: DateTime(2026, 4, 23),
    );

    expect(result.importedCount, 2);
    expect(result.skippedRows, 1);
    expect(result.state.holdings.map((holding) => holding.ticker), [
      'MSFT',
      'NVDA',
    ]);
    expect(
      result.state.holdingByTicker('NVDA')!.averageCostBasis,
      closeTo(820.10, 0.01),
    );
    expect(
      result.state.holdingByTicker('MSFT')!.averageCostBasis,
      closeTo(410.00, 0.01),
    );
  });

  test('upserts and removes holdings by normalized ticker', () {
    final state = PortfolioState.empty
        .upsertHolding(
          PortfolioHolding(
            ticker: ' nvda ',
            shares: 1,
            addedAt: DateTime(2026, 4, 23),
          ),
        )
        .upsertHolding(
          PortfolioHolding(
            ticker: 'NVDA',
            shares: 3,
            addedAt: DateTime(2026, 4, 23),
          ),
        );

    expect(state.holdings, hasLength(1));
    expect(state.holdingByTicker('nvda')!.shares, 3);
    expect(state.removeHolding('NVDA').holdings, isEmpty);
  });
}
