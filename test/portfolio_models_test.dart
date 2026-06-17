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

  test('parses Fidelity export rows and captures the money market cash line', () {
    final result = parsePortfolioHoldingsCsv(
      'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Type\n'
      'X85989591,Individual - TOD,SPAXX**,HELD IN MONEY MARKET,,,\$286850.51,, ,Cash,\n'
      'X85989591,Individual - TOD,IONQ,IONQ INC COM,136,\$43.46,\$5910.56,\$1053.49,\$7.75,Equity,\n'
      'X85989591,Individual - TOD,LMT,LOCKHEED MARTIN CORP COM USD1.00,3.091,\$533.46,\$1648.92,\$1468.05,\$474.94,Equity,\n',
      importedAt: DateTime(2026, 4, 23),
    );

    expect(result.importedCount, 2);
    expect(result.skippedRows, 0);
    expect(result.importedCashBalance, closeTo(286850.51, 0.01));
    expect(result.state.cashBalance, closeTo(286850.51, 0.01));
    expect(result.state.holdings.map((holding) => holding.ticker), [
      'IONQ',
      'LMT',
    ]);
    expect(
      result.state.holdingByTicker('IONQ')!.averageCostBasis,
      closeTo(7.75, 0.01),
    );
    expect(
      result.state.holdingByTicker('IONQ')!.currentValue,
      closeTo(5910.56, 0.01),
    );
    expect(result.state.trackedAccountValue, closeTo(294409.99, 0.01));
  });
}
