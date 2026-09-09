import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/default_symbol_universe.dart';
import 'package:finance_app/src/data/expanded_symbol_universe.dart';
import 'package:finance_app/src/data/fixture_market_repository.dart';
import 'package:finance_app/src/data/market_data_configuration.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('default universe tracks a broad stock and ETF catalog', () {
    final symbols = kDefaultSymbolUniverse.toSet();
    final etfCount = symbols
        .where((symbol) => defaultSymbolProfileFor(symbol)?.isEtf ?? false)
        .length;
    final stockCount = symbols.length - etfCount;

    expect(symbols.length, greaterThanOrEqualTo(1300));
    expect(stockCount, greaterThanOrEqualTo(1000));
    expect(etfCount, greaterThanOrEqualTo(250));
    expect(symbols.containsAll(['AAPL', 'NVDA', 'JPM', 'LLY']), isTrue);
    expect(symbols.containsAll(['SPY', 'QQQ', 'XLK', 'HYG', 'TLT']), isTrue);

    final configuration = MarketDataConfiguration.fromEnvironment();
    expect(
      configuration.alphaVantageSymbols.length,
      greaterThanOrEqualTo(kDefaultSymbolUniverse.length),
    );
    expect(
      configuration.stockUniverseLimit,
      greaterThanOrEqualTo(kDefaultStockUniverseLimit),
    );
  });

  test('generated catalog merges cleanly with the hand-built universe', () {
    // The hand-built set, normalized so a class share cannot hide behind the
    // dot-versus-dash spelling difference.
    final handBuilt = <String>{};
    for (final bucket in kHandBuiltSymbolBuckets) {
      for (final raw in bucket.symbols) {
        handBuilt.add(raw.trim().toUpperCase().replaceAll('-', '.'));
      }
    }

    final generated = <String>{};
    for (final bucket in kGeneratedSymbolBuckets) {
      for (final raw in bucket.symbols) {
        final symbol = raw.trim().toUpperCase();
        expect(
          handBuilt.contains(symbol.replaceAll('-', '.')),
          isFalse,
          reason: '$symbol duplicates a hand-curated entry',
        );
        expect(
          generated.add(symbol),
          isTrue,
          reason: '$symbol appears twice inside the generated catalog',
        );
      }
    }

    // The generator was run for real, so the catalog must be substantial and
    // the merged universe must be exactly the two halves with no overlap.
    // The floors dropped from 3,000 and 5,500 on 2026-09-09, when 657
    // entries that were not the instrument they claimed to be came out:
    // 390 closed-end funds and bond trusts wearing a "no SEC industry data"
    // label, 255 pre-merger blank-check shells, 8 warrants, units, rights
    // and preferreds, and 5 inverse funds. A shrunken honest catalog is the
    // point, so the floors sit just under the real counts of 2,843 and
    // 5,343 rather than being loosened to nothing.
    expect(generated.length, greaterThanOrEqualTo(2800));
    expect(kDefaultSymbolUniverse.length, handBuilt.length + generated.length);
    expect(kDefaultSymbolUniverse.length, greaterThanOrEqualTo(5300));
  });

  test('no known contaminant instrument survives in the merged universe', () {
    // Every symbol below was found in the shipped catalog and then checked
    // against a real quoted price. None is the kind of instrument its bucket
    // claimed. The first eight are warrants, units, rights and preferred
    // shares that inherited their parent company's sector, so they looked
    // like ordinary stocks - PSNYW traded at $4.25 while its parent PSNY
    // traded at $7.96. The last five are inverse or long-short ProShares
    // funds, which bet against a market rather than owning it.
    //
    // The second group was found in a later review pass. Those reached the
    // catalog through a different hole: leverage and inverse exposure were
    // only screened on the fund path, and an exchange-traded note is flagged
    // as a stock in the exchange directories, so FNGD (a minus-three-times
    // note) and DZZ (minus-two-times gold, quoted at $1.68 against a $12.50
    // high) were filed as common stocks of commercial banks. The rest are
    // pass-through certificates holding somebody else's bonds, one closed-end
    // fund that happened to carry a usable industry code, and royalty grantor
    // trusts sitting on a depleting asset. None of them is an operating
    // company, and this engine ranks operating companies.
    const contaminants = {
      'AMPGZ',
      'CDZIP',
      'GENVR',
      'HCICR',
      'NOVTU',
      'PSNYW',
      'VSECU',
      'WAFDP',
      'BITI',
      'CLIX',
      'DOG',
      'EFZ',
      'EMTY',
      // leveraged and inverse exchange-traded notes filed as bank stocks
      'DGP',
      'DGZ',
      'DZZ',
      'FNGD',
      // structured bond pass-through certificates
      'GJH',
      'GJO',
      'GJP',
      'GJR',
      'GJT',
      'JBK',
      'KTN',
      'PYT',
      // closed-end fund with a plausible industry code
      'NFJ',
      // royalty grantor trusts, not operating companies
      'CRT',
      'MTR',
      'NRT',
      'PBT',
      'SBR',
      'SJT',
      'MSB',
    };

    final universe = kDefaultSymbolUniverse
        .map((symbol) => symbol.trim().toUpperCase())
        .toSet();
    for (final symbol in contaminants) {
      expect(
        universe.contains(symbol),
        isFalse,
        reason:
            '$symbol is not the instrument its bucket claims and must not be '
            'scored; see the header of expanded_symbol_universe.dart',
      );
    }

    // The two buckets that carried the other 645 removals must stay gone.
    // "Unclassified" was the generator saying "the SEC has no industry code
    // for this" and then filing it as a stock anyway; "Blank Checks" is the
    // SEC's own code for a pre-merger acquisition shell whose price is just
    // its trust account creeping toward a payout, which a momentum score
    // reads as a flawless low-risk uptrend.
    for (final bucket in kGeneratedSymbolBuckets) {
      expect(
        bucket.sector,
        isNot('Unclassified'),
        reason:
            'an Unclassified bucket means the generator kept an instrument '
            'it could not identify',
      );
      expect(
        bucket.industry,
        isNot('Blank Checks'),
        reason: 'blank-check SPAC shells must not be scored',
      );
    }
  });

  test('every generated bucket carries a usable profile', () {
    // These are the sector names the backend's benchmark map, breadth
    // grouping, and sector-adjusted fundamental ranks understand.
    // "Unclassified" used to be on this list as a deliberate fallback that
    // the backend benchmarked against SPY. It came off on 2026-09-09: in
    // practice it was not a fallback but a wastebasket, holding 390 listings
    // the generator could not identify and had guessed were common stocks.
    // They were closed-end funds, municipal bond trusts and
    // business-development companies. A sector the generator cannot name is
    // now a reason to leave the listing out, so no bucket may carry it.
    const knownSectors = {
      'Technology',
      'Software',
      'Communications',
      'Consumer',
      'Consumer Discretionary',
      'Consumer Staples',
      'Healthcare',
      'Financials',
      'Energy',
      'Industrials',
      'Materials',
      'Real Estate',
      'Utilities',
      'ETF / Macro',
      'Speculative Growth',
    };
    final universe = kDefaultSymbolUniverse.toSet();
    final symbolShape = RegExp(r'^[A-Z][A-Z.]{0,7}$');

    // Nasdaq reserves the fifth letter of a five-character symbol for the
    // security class, and W, U, R, P and Z mean warrant, unit, right, and
    // the preferred and when-issued classes. The shape check above accepts
    // all of them happily, which is how AMPGZ, CDZIP, GENVR, HCICR, NOVTU,
    // PSNYW, VSECU and WAFDP reached the shipped catalog wearing their
    // parent company's sector.
    //
    // This rejection is applied only to the GENERATED buckets below, never
    // to the merged universe, because the hand-curated catalog deliberately
    // holds a set of preferred shares and units of its own - AGNCP, HBANZ,
    // SLMBP, BTSGU and the rest - which are hand-chosen with hand-set biases
    // and are not the thing this test is guarding against.
    final nasdaqClassSuffix = RegExp(r'^[A-Z]{4}[WURPZ]$');

    expect(kGeneratedSymbolBuckets, isNotEmpty);
    for (final bucket in kGeneratedSymbolBuckets) {
      expect(
        knownSectors.contains(bucket.sector),
        isTrue,
        reason: 'unknown sector "${bucket.sector}"',
      );
      expect(bucket.industry.trim(), isNotEmpty);
      expect(
        universe.contains(bucket.templateTicker),
        isTrue,
        reason:
            'templateTicker ${bucket.templateTicker} is not in the universe',
      );
      expect(bucket.symbols, isNotEmpty);
      for (final symbol in bucket.symbols) {
        expect(
          symbolShape.hasMatch(symbol),
          isTrue,
          reason: 'symbol "$symbol" has an unexpected shape',
        );
        expect(
          nasdaqClassSuffix.hasMatch(symbol),
          isFalse,
          reason:
              'symbol "$symbol" ends in a Nasdaq class letter, so it is a '
              'warrant, unit, right or preferred rather than the common '
              'stock its bucket describes',
        );
      }
      // Generated entries carry no bias at all. The promise the generator
      // makes is neutrality, exactly zero, not merely a small number, so
      // this asserts the promise rather than a tolerance around it - a
      // tolerance of ten would have quietly accepted a hand-tuned thumb on
      // the scale hiding inside a file marked "do not edit by hand".
      for (final bias in [
        bucket.momentumBias,
        bucket.qualityBias,
        bucket.valuationBias,
        bucket.riskBias,
        bucket.growthBias,
        bucket.defensiveBias,
        bucket.creditBias,
        bucket.rateBias,
      ]) {
        expect(bias, 0);
      }
    }
  });

  test(
    'fixture fast-start universe includes ETFs inside wider scans',
    () async {
      final state = await FixtureMarketRepository(
        stockUniverseLimit: 180,
        historicalSnapshotLimit: 70,
      ).loadState();
      final tickers = state.snapshot.rankedUniverse
          .map((stock) => stock.ticker)
          .toSet();

      expect(state.snapshot.rankedUniverse, hasLength(180));
      expect(tickers.containsAll(['QQQ', 'XLK', 'HYG', 'TLT']), isTrue);
    },
  );
}
