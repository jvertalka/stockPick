// Builds lib/src/data/expanded_symbol_universe.dart from free, official
// sources, so the decision universe can grow far past the hand-built list
// without any API key and without any paid data.
//
// What it does, start to finish:
//   1. Downloads the two official listing directories that Nasdaq publishes
//      for every US-listed security (nasdaqlisted.txt for Nasdaq's own
//      listings, otherlisted.txt for NYSE, NYSE American, NYSE Arca, Cboe
//      BZX, and IEX). Both are plain pipe-separated text, free, and keyless.
//   2. Throws away everything that is not a plain common stock, ADR, or
//      ETF: test issues, warrants, units, rights, preferred shares,
//      exchange-traded notes, baby bonds, inverse and leveraged funds, and
//      Nasdaq listings flagged deficient, delinquent, or bankrupt. A
//      security's type is read from its name and, for five-character
//      symbols, from the class letter Nasdaq reserves as the fifth
//      character.
//   3. Excludes every symbol that already lives in the hand-built catalog in
//      default_symbol_universe.dart, because hand-curated entries always win.
//   4. Orders the surviving common stocks by listing tier (the strictest
//      listing standards first) and keeps the top kGeneratedCommonStockCap.
//      Orders the surviving ETFs so funds from the largest issuers come
//      first and keeps the top kGeneratedEtfCap.
//   5. Looks up each kept stock's SEC central index key in the SEC's free
//      company_tickers.json, then asks SEC EDGAR for that company's SIC
//      industry code and maps it onto the sector names the app already uses.
//      SEC requests carry the contact User-Agent the SEC requires and stay
//      well under the SEC's ten-requests-per-second ceiling. Results are
//      cached on disk, so re-runs only fetch what is new. A listing the SEC
//      cannot place in an industry is dropped here rather than assumed to
//      be a stock, and so is any blank-check acquisition shell, so the
//      final stock count normally lands under kGeneratedCommonStockCap.
//   6. Emits lib/src/data/expanded_symbol_universe.dart as a generated Dart
//      file of DefaultSymbolBucket entries with neutral biases, and runs
//      dart format on it.
//
// How to run it, from the repository root:
//
//   dart run tool/generate_expanded_universe.dart
//
// Useful flags:
//   --offline      never touch the network; fail if the cache is incomplete.
//   --refresh      ignore cached listing files and download fresh copies
//                  (the per-company SIC cache is still reused, because SIC
//                  codes change extremely rarely).
//   --cache-dir=X  where to keep downloads and the SIC cache. The default is
//                  a folder inside the system temp directory, so nothing
//                  lands in the repository except the emitted Dart file.

import 'dart:convert';
import 'dart:io';

import 'package:finance_app/src/data/default_symbol_universe.dart';

// The SEC requires every automated client to identify itself with a contact
// address. This is the same identity the backend uses for EDGAR fundamentals.
const String kSecUserAgent =
    'FinanceOracle research joshua.j.vertalka@gmail.com';

// How many generated common stocks to keep, ordered by listing tier. The cap
// exists because the price store and the boot warmup both grow linearly with
// the universe: the store was measured at roughly 116 KB per symbol (doubled
// on disk by its .bak twin), and a throttled warmup pass lands only about
// 35 to 45 names. At 3,000 generated stocks plus 500 generated ETFs the
// effective universe is about 6,000 names, which means roughly 680 MB of
// price history (1.4 GB with the backup copy) and a worst-case cold warmup
// of about 170 throttled passes -- both workable, which is why the warmup
// pass backstop in tool/backend_cache_server.dart now scales with universe
// size instead of staying pinned at 150.
const int kGeneratedCommonStockCap = 3000;

// How many generated ETFs to keep. ETFs carry no SEC fundamentals in this
// app (they are scored price-only), so common stocks get most of the budget
// and ETFs fill a smaller tranche on top of the roughly 320 hand-curated
// funds that already cover the major indexes, sectors, factors, and bonds.
const int kGeneratedEtfCap = 500;

// Where each generated sector points for fixture and demo data. Every value
// here already exists in the hand-built universe, and the fixture repository
// falls back harmlessly if a template is ever missing, but keeping these on
// well-known anchors keeps demo mode sensible.
const Map<String, String> kSectorTemplateTickers = {
  'Technology': 'MSFT',
  'Software': 'MSFT',
  'Communications': 'GOOGL',
  'Consumer': 'AMZN',
  'Consumer Discretionary': 'AMZN',
  'Consumer Staples': 'PG',
  'Healthcare': 'LLY',
  'Financials': 'JPM',
  'Real Estate': 'PLD',
  'Energy': 'XOM',
  'Utilities': 'NEE',
  'Industrials': 'CAT',
  'Materials': 'LIN',
  'Speculative Growth': 'NVDA',
  'ETF / Macro': 'MSFT',
  'Unclassified': 'MSFT',
};

// One row from either listing directory, reduced to what the pipeline needs.
class ListingCandidate {
  ListingCandidate({
    required this.symbol,
    required this.name,
    required this.isEtf,
    required this.tier,
    required this.exchangeLabel,
  });

  final String symbol;
  final String name;
  final bool isEtf;

  // Listing tier is the only liquidity signal the free directories carry.
  // Tier 0 is NYSE and Nasdaq Global Select (the strictest listing
  // standards), tier 1 is Nasdaq Global Market and NYSE American, tier 2 is
  // everything else (Nasdaq Capital Market, Arca, BZX, IEX).
  final int tier;
  final String exchangeLabel;

  // Whether the SEC knows this company. Filled in after the CIK join.
  int? cik;
  String sector = 'Unclassified';
  String industry = 'US-listed stock (no SEC industry data)';
}

// The SIC industry code and its plain-language description for one company,
// as SEC EDGAR reports them.
class SicRecord {
  SicRecord(this.sic, this.description);

  final String sic;
  final String description;
}

Future<void> main(List<String> args) async {
  var offline = false;
  var refresh = false;
  String? cacheDirArg;
  var outPath = 'lib/src/data/expanded_symbol_universe.dart';
  for (final arg in args) {
    if (arg == '--offline') {
      offline = true;
    } else if (arg == '--refresh') {
      refresh = true;
    } else if (arg.startsWith('--cache-dir=')) {
      cacheDirArg = arg.substring('--cache-dir='.length);
    } else if (arg.startsWith('--out=')) {
      outPath = arg.substring('--out='.length);
    } else {
      stderr.writeln('Unknown argument: $arg');
      exitCode = 64;
      return;
    }
  }

  final cacheDir = Directory(
    cacheDirArg ??
        '${Directory.systemTemp.path}${Platform.pathSeparator}finance_oracle_universe_generator',
  );
  await cacheDir.create(recursive: true);
  stdout.writeln('Cache directory: ${cacheDir.path}');

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 20);

  try {
    // Step 1: the two listing directories and the SEC ticker-to-CIK map.
    final nasdaqListed = await _cachedDownload(
      client: client,
      cacheDir: cacheDir,
      fileName: 'nasdaqlisted.txt',
      url: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
      offline: offline,
      refresh: refresh,
    );
    final otherListed = await _cachedDownload(
      client: client,
      cacheDir: cacheDir,
      fileName: 'otherlisted.txt',
      url: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
      offline: offline,
      refresh: refresh,
    );
    final companyTickers = await _cachedDownload(
      client: client,
      cacheDir: cacheDir,
      fileName: 'company_tickers.json',
      url: 'https://www.sec.gov/files/company_tickers.json',
      offline: offline,
      refresh: refresh,
      userAgent: kSecUserAgent,
    );

    // Step 2: filter both directories down to plain stocks and ETFs.
    final candidates = <String, ListingCandidate>{};
    final dropCounts = <String, int>{};
    void drop(String reason) {
      dropCounts[reason] = (dropCounts[reason] ?? 0) + 1;
    }

    // Symbols the hand-built catalog already owns. The comparison normalizes
    // dashes to dots so a class share can never sneak in twice under the two
    // spellings (the app stores BRK.B; some sources write BRK-B).
    final handBuilt = <String>{};
    for (final bucket in kHandBuiltSymbolBuckets) {
      for (final raw in bucket.symbols) {
        handBuilt.add(raw.trim().toUpperCase().replaceAll('-', '.'));
      }
    }

    void consider({
      required String rawSymbol,
      required String name,
      required bool isEtf,
      required int tier,
      required String exchangeLabel,
    }) {
      final symbol = rawSymbol.trim().toUpperCase();
      // Plain share classes use a dot; anything else punctuation-wise is a
      // derivative security or a data oddity and is not wanted.
      if (!RegExp(r'^[A-Z][A-Z.]{0,7}$').hasMatch(symbol)) {
        drop('unusual symbol characters');
        return;
      }
      if (!isEtf && _isNasdaqSuffixedSecurity(symbol, name)) {
        drop('fifth-letter warrant, unit, right, or preferred');
        return;
      }
      if (_isDerivativeSecurityName(name, isEtf: isEtf)) {
        drop(
          isEtf
              ? 'leveraged, inverse, or note-style fund'
              : 'warrant, unit, right, preferred, or note',
        );
        return;
      }
      if (handBuilt.contains(symbol.replaceAll('-', '.'))) {
        drop('already hand-curated');
        return;
      }
      if (candidates.containsKey(symbol)) {
        drop('duplicate across directories');
        return;
      }
      candidates[symbol] = ListingCandidate(
        symbol: symbol,
        name: name,
        isEtf: isEtf,
        tier: tier,
        exchangeLabel: exchangeLabel,
      );
    }

    for (final row in _parsePipeFile(nasdaqListed)) {
      if (row['Test Issue'] == 'Y') {
        drop('test issue');
        continue;
      }
      if (row['NextShares'] == 'Y') {
        drop('NextShares');
        continue;
      }
      // Financial Status other than N means Nasdaq has flagged the listing
      // as deficient, delinquent, or bankrupt. Those names cannot hold an
      // evidence-grade signal, so they are skipped entirely.
      if ((row['Financial Status'] ?? 'N') != 'N') {
        drop('deficient or delinquent listing');
        continue;
      }
      final category = row['Market Category'] ?? '';
      consider(
        rawSymbol: row['Symbol'] ?? '',
        name: row['Security Name'] ?? '',
        isEtf: row['ETF'] == 'Y',
        tier: category == 'Q' ? 0 : (category == 'G' ? 1 : 2),
        exchangeLabel: 'Nasdaq $category',
      );
    }

    for (final row in _parsePipeFile(otherListed)) {
      if (row['Test Issue'] == 'Y') {
        drop('test issue');
        continue;
      }
      final nasdaqSymbol = row['NASDAQ Symbol'] ?? '';
      // In the cross-exchange file the symbol itself encodes the security
      // type: + is a warrant, = is a unit, ^ is a right, - is a preferred
      // share, $ never appears on a plain listing. A dot is a share class
      // and stays.
      if (nasdaqSymbol.contains('+') ||
          nasdaqSymbol.contains('=') ||
          nasdaqSymbol.contains('^') ||
          nasdaqSymbol.contains('-') ||
          nasdaqSymbol.contains(r'$')) {
        drop('warrant, unit, right, preferred, or note');
        continue;
      }
      final exchange = row['Exchange'] ?? '';
      consider(
        rawSymbol: nasdaqSymbol,
        name: row['Security Name'] ?? '',
        isEtf: row['ETF'] == 'Y',
        tier: exchange == 'N' ? 0 : (exchange == 'A' ? 1 : 2),
        exchangeLabel:
            {
              'N': 'NYSE',
              'A': 'NYSE American',
              'P': 'NYSE Arca',
              'Z': 'Cboe BZX',
              'V': 'IEX',
            }[exchange] ??
            'Other',
      );
    }

    final stocks = candidates.values.where((c) => !c.isEtf).toList();
    final etfs = candidates.values.where((c) => c.isEtf).toList();
    stdout.writeln(
      'Candidates after filtering: ${stocks.length} common stocks, '
      '${etfs.length} ETFs.',
    );
    for (final entry in dropCounts.entries) {
      stdout.writeln('  dropped (${entry.key}): ${entry.value}');
    }

    // Step 3: join stocks to the SEC ticker map so each one carries a CIK.
    final cikByTicker = <String, int>{};
    final tickerMap = jsonDecode(companyTickers) as Map<String, dynamic>;
    for (final value in tickerMap.values) {
      final entry = value as Map<String, dynamic>;
      final ticker = (entry['ticker'] as String).toUpperCase();
      // First entry wins; the SEC file lists larger filers first.
      cikByTicker.putIfAbsent(ticker, () => entry['cik_str'] as int);
    }
    for (final stock in stocks) {
      // The SEC map writes share classes with a dash where the app uses a
      // dot, so the lookup translates.
      stock.cik = cikByTicker[stock.symbol.replaceAll('.', '-')];
    }

    // Step 4: order and cap. Listing tier first (a proxy for listing
    // standards and typical liquidity, the only such signal in the free
    // directories), then names the SEC knows (they get free fundamentals),
    // then alphabetically so the result is deterministic.
    stocks.sort((a, b) {
      if (a.tier != b.tier) {
        return a.tier.compareTo(b.tier);
      }
      final aHasCik = a.cik != null ? 0 : 1;
      final bHasCik = b.cik != null ? 0 : 1;
      if (aHasCik != bHasCik) {
        return aHasCik.compareTo(bHasCik);
      }
      return a.symbol.compareTo(b.symbol);
    });
    var keptStocks = stocks.take(kGeneratedCommonStockCap).toList();

    // ETFs: funds from the largest issuers first (issuer scale is the best
    // free stand-in for fund size and trading volume), then alphabetically.
    etfs.sort((a, b) {
      final aMajor = _etfIssuerLabel(a.name) != null ? 0 : 1;
      final bMajor = _etfIssuerLabel(b.name) != null ? 0 : 1;
      if (aMajor != bMajor) {
        return aMajor.compareTo(bMajor);
      }
      return a.symbol.compareTo(b.symbol);
    });
    final keptEtfs = etfs.take(kGeneratedEtfCap).toList();

    // Step 5: fetch each kept stock's SIC industry code from SEC EDGAR and
    // turn it into one of the app's sector names.
    final ciks = keptStocks
        .where((stock) => stock.cik != null)
        .map((stock) => stock.cik!)
        .toSet()
        .toList();
    final sicByCik = await _loadOrFetchSicRecords(
      client: client,
      cacheDir: cacheDir,
      ciks: ciks,
      offline: offline,
    );
    final candidateStockCount = keptStocks.length;
    final classifiedStocks = <ListingCandidate>[];
    var droppedUnknown = 0;
    var droppedBlankCheck = 0;
    for (final stock in keptStocks) {
      final record = stock.cik != null ? sicByCik[stock.cik] : null;
      final sicNumber = record == null ? null : int.tryParse(record.sic.trim());

      // No usable SIC code means the SEC does not tell us what this listing
      // is, and "I do not know what this is" is not the same claim as "it is
      // a common stock". Reading it as a stock is what put 390 closed-end
      // funds, municipal bond trusts and business-development companies into
      // the shipped catalog under the invented label "US-listed stock (no
      // SEC industry data)" - Nuveen and PIMCO municipal funds, BlackRock
      // trusts, Eagle Point Credit, Palmer Square. Every one of them is
      // priced off a bond portfolio and a discount to net asset value, not
      // off company earnings, so nothing the engine scores applies to them.
      // Skipping is why the emitted stock count can finish below the cap;
      // that is the intended trade, a smaller honest catalog over a full one
      // with several hundred mislabelled entries in it.
      if (record == null || sicNumber == null || sicNumber <= 0) {
        droppedUnknown++;
        continue;
      }

      // SIC 6770 is "Blank Checks", the SEC's code for a special-purpose
      // acquisition shell that has not merged yet. Its share price is barely
      // a price: it is the trust account, parked just under ten dollars and
      // creeping toward the payout. A momentum score reads that steady creep
      // as a flawless, almost riskless uptrend, so 255 empty shells could
      // rank near the top of the board for exactly the wrong reason.
      if (sicNumber == 6770) {
        droppedBlankCheck++;
        continue;
      }

      stock.sector = _sectorForSic(record.sic);

      // A SIC code the sector map does not place is the same "I do not know"
      // as no code at all, so it goes out with the rest rather than being
      // filed under an Unclassified catch-all. This is what the four
      // symbols labelled "SIC 0000" were: closed-end funds again.
      if (stock.sector == 'Unclassified') {
        droppedUnknown++;
        continue;
      }

      stock.industry = record.description.isEmpty
          ? 'SIC ${record.sic}'
          : _cleanIndustry(record.description);
      classifiedStocks.add(stock);
    }
    keptStocks = classifiedStocks;
    stdout.writeln(
      'Sector classification: ${keptStocks.length} of $candidateStockCount '
      'candidate stocks carry usable SEC industry data.',
    );
    stdout.writeln('  dropped (no usable SEC industry code): $droppedUnknown');
    stdout.writeln('  dropped (blank-check SPAC shell): $droppedBlankCheck');

    // Step 6: emit the generated Dart file.
    final output = _emitDart(keptStocks: keptStocks, keptEtfs: keptEtfs);
    final outFile = File(outPath);
    await outFile.writeAsString(output);
    stdout.writeln('Wrote ${outFile.path} (${output.length} characters).');

    // Formatting is cosmetic, so a missing dart binary is not fatal.
    try {
      final format = await Process.run('dart', ['format', outPath]);
      if (format.exitCode != 0) {
        stdout.writeln('dart format reported: ${format.stderr}');
      }
    } on ProcessException {
      stdout.writeln(
        'Could not run dart format; format the emitted file manually.',
      );
    }

    final handBuiltCount = handBuilt.length;
    stdout.writeln(
      'Effective universe: $handBuiltCount hand-built + '
      '${keptStocks.length} generated stocks + ${keptEtfs.length} generated '
      'ETFs = ${handBuiltCount + keptStocks.length + keptEtfs.length} '
      'symbols.',
    );
  } finally {
    client.close(force: true);
  }
}

// ---------------------------------------------------------------------------
// Filtering helpers.
// ---------------------------------------------------------------------------

final RegExp _preferredName = RegExp(
  'preferred|preference',
  caseSensitive: false,
);
final RegExp _preferredBankException = RegExp(
  '^preferred bank',
  caseSensitive: false,
);
final RegExp _derivativeName = RegExp(
  r'[-–] ?(warrant|unit|right)s?\b|\bwarrants?\b|\bsubscription rights?\b',
  caseSensitive: false,
);
final RegExp _noteName = RegExp(
  r'\bnotes? due\b|% notes|\bsenior notes?\b|\bsubordinated\b|\bdebenture',
  caseSensitive: false,
);
final RegExp _exchangeTradedNoteName = RegExp(
  // The abbreviation matters as much as the phrase. DGP, DGZ, DZZ and FNGD
  // all reached the shipped catalog naming themselves "... ETN" while the
  // pattern only knew "exchange-traded note" written out in full.
  r'etracs|ipath|exchange[- ]traded notes?|ETNs?',
  caseSensitive: false,
);
final RegExp _leveragedFundName = RegExp(
  r'\b\d(\.\d+)?x\b|\bultra(pro|short)?\b|\binverse\b|\bbear\b|-1x|2x|3x|1\.5x|leveraged',
  caseSensitive: false,
);

// Inverse funds that say so in plain words instead of with a multiplier.
// This exists because BITI, CLIX, DOG, EFZ and EMTY all reached the shipped
// catalog: ProShares names its entire one-times-inverse line "Short
// <something>", and the filter above only knew "ultra", "inverse", "bear"
// and an Nx multiplier. A fund that bets against a market is not an
// investment candidate for this engine, so it should never have been ranked.
//
// The word "short" on its own cannot condemn a fund, because short-dated
// bond funds are named with it too: "Short-Term Treasury", "Short Duration
// Income", "iShares Short Treasury Bond" are all ordinary long-only bond
// funds. What separates them is the word that comes next, because the two
// uses of "short" mean different things. In a bond fund it describes TIME,
// and time is spelled out in a small closed set of words - term, duration,
// maturity, dated, intermediate - or in the fixed-income noun the fund holds
// - treasuries, obligations, income. In an inverse fund it names the MARKET
// being bet against, which is an index, a sector, an asset, or a maturity
// written as a number: "Short S&P500", "Short High Yield", "Short Dow30",
// "Short MSCI EAFE", "Short 20+ Year Treasury", "Short Bitcoin Strategy".
// So the screen fires on "short" unless a time or fixed-income word follows
// it, which keeps "Short-Term Corporate Bond" and "Short Obligations" while
// still dropping "Short Financials" and "Short QQQ".
//
// EMTY, the "Decline of the Retail Store ETF", carries no keyword at all,
// which is why the phrase "decline of" is screened separately.
final RegExp _inverseFundName = RegExp(
  r'\bshort\b(?![-\s]*'
  r'(term|duration|maturity|dated|intermediate|treasur|obligation|income|muni))'
  r'|\bdecline of\b',
  caseSensitive: false,
);

// Nasdaq's own directory carries no security-type column: nasdaqlisted.txt
// has Symbol, Security Name, Market Category, Test Issue, Financial Status,
// Round Lot Size, ETF and NextShares, and nothing that says "this is a
// warrant". The type is encoded in the symbol instead - a five-character
// Nasdaq-style symbol reserves its fifth letter for the security class, and
// W, U, R, P and Z mean warrant, unit, right, and the two preferred and
// when-issued classes. The cross-exchange file otherlisted.txt does mark the
// type with punctuation, which is already screened, but the "NASDAQ Symbol"
// column of that same file re-spells those listings in the fifth-letter
// style with the punctuation stripped, so a NYSE warrant arrives here
// looking like a clean five-letter ticker. That is how AMPGZ, CDZIP, GENVR,
// HCICR, NOVTU, PSNYW, VSECU and WAFDP got in, each inheriting its parent
// company's sector and looking perfectly plausible: PSNYW traded at $4.25
// against its parent PSNY at $7.96.
//
// The letter alone is only a strong hint, not proof, because Nasdaq also
// hands out five-character root symbols to ordinary companies. So the letter
// raises the question and Security Name settles it. These directories always
// end a security's name with its instrument type, so a name still ending in
// plain-equity words is kept and everything else is dropped. On the
// 2026-08-26 directories nothing in the shipped catalog needed that rescue,
// which is the evidence that the letter rule is not throwing away real
// stocks; the rescue is there for the day a genuine five-letter root ending
// in one of these letters is listed.
final RegExp _nasdaqSuffixedSymbol = RegExp(r'^[A-Z]{4}[WURPZ]$');
final RegExp _plainEquityNameEnding = RegExp(
  r'(common stock|common shares|ordinary shares?|'
  r'american depositary shares?|american depositary receipts?|'
  r'shares of beneficial interest)'
  r'[\s,.]*$',
  caseSensitive: false,
);

bool _isNasdaqSuffixedSecurity(String symbol, String name) {
  if (!_nasdaqSuffixedSymbol.hasMatch(symbol)) {
    return false;
  }
  return !_plainEquityNameEnding.hasMatch(name.trim());
}

// Says whether a security name describes something other than a plain stock
// or plain fund. Stocks are screened for warrants, units, rights, preferred
// shares, and listed debt, because those either cannot be scored or would
// poison the fundamentals join. ETFs are screened for exchange-traded notes
// and for leveraged and inverse products, because daily-reset leverage decays
// by construction and is not an investment candidate for this engine.
bool _isDerivativeSecurityName(String name, {required bool isEtf}) {
  // Leverage, inverse exposure and note structure are screened on BOTH paths,
  // not just the fund path. An exchange-traded note is flagged as a stock in
  // the exchange directories, so when these three checks lived only inside the
  // isEtf branch a minus-three-times note (FNGD) and a minus-two-times gold
  // note (DZZ) were filed as common stocks of commercial banks and scored as
  // if they were operating businesses.
  if (_exchangeTradedNoteName.hasMatch(name) ||
      _leveragedFundName.hasMatch(name) ||
      _inverseFundName.hasMatch(name)) {
    return true;
  }
  if (isEtf) {
    return false;
  }
  if (_preferredName.hasMatch(name) &&
      !_preferredBankException.hasMatch(name)) {
    // "Preferred Bank" of Los Angeles is a real commercial bank whose legal
    // name begins with the word preferred; it is the one known exception.
    return true;
  }
  return _derivativeName.hasMatch(name) ||
      _noteName.hasMatch(name) ||
      _exchangeTradedNoteName.hasMatch(name);
}

// The big established ETF issuers, matched against the start of the fund
// name. Issuer scale correlates strongly with fund assets and daily volume,
// and it is the only ranking signal available in the free directory files.
// Buffered-outcome series shops (Innovator, FT Vest, AllianzIM) and
// single-stock income shops (YieldMax, Roundhill, Corgi) are deliberately
// absent: their catalogs are hundreds of tiny niche series.
const List<MapEntry<String, String>> _majorEtfIssuers = [
  MapEntry('ishares', 'iShares'),
  MapEntry('vanguard', 'Vanguard'),
  MapEntry('spdr', 'SPDR'),
  MapEntry('state street', 'SPDR'),
  MapEntry('invesco', 'Invesco'),
  MapEntry('schwab', 'Schwab'),
  MapEntry('fidelity', 'Fidelity'),
  MapEntry('first trust', 'First Trust'),
  MapEntry('vaneck', 'VanEck'),
  MapEntry('wisdomtree', 'WisdomTree'),
  MapEntry('jpmorgan', 'JPMorgan'),
  MapEntry('j.p. morgan', 'JPMorgan'),
  MapEntry('dimensional', 'Dimensional'),
  MapEntry('goldman', 'Goldman Sachs'),
  MapEntry('franklin', 'Franklin'),
  MapEntry('xtrackers', 'Xtrackers'),
  MapEntry('pacer', 'Pacer'),
  MapEntry('global x', 'Global X'),
  MapEntry('proshares', 'ProShares'),
  MapEntry('kraneshares', 'KraneShares'),
  MapEntry('avantis', 'Avantis'),
  MapEntry('american century', 'American Century'),
  MapEntry('t. rowe', 'T. Rowe Price'),
  MapEntry('nuveen', 'Nuveen'),
  MapEntry('capital group', 'Capital Group'),
  MapEntry('janus', 'Janus Henderson'),
  MapEntry('harbor', 'Harbor'),
  MapEntry('calamos', 'Calamos'),
  MapEntry('pgim', 'PGIM'),
  MapEntry('columbia', 'Columbia'),
  MapEntry('flexshares', 'FlexShares'),
  MapEntry('john hancock', 'John Hancock'),
  MapEntry('hartford', 'Hartford'),
  MapEntry('victoryshares', 'VictoryShares'),
  MapEntry('motley fool', 'Motley Fool'),
  MapEntry('alps', 'ALPS'),
  MapEntry('abrdn', 'abrdn'),
];

// Returns the display name of the issuer when the fund comes from one of the
// major families above, or null for everything else.
String? _etfIssuerLabel(String name) {
  final lower = name.toLowerCase();
  for (final issuer in _majorEtfIssuers) {
    if (lower.startsWith(issuer.key)) {
      return issuer.value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing helpers.
// ---------------------------------------------------------------------------

// Turns one of Nasdaq's pipe-separated directory files into a list of maps
// keyed by the header row, skipping the "File Creation Time" footer.
List<Map<String, String>> _parsePipeFile(String content) {
  final lines = const LineSplitter().convert(content);
  if (lines.isEmpty) {
    return const [];
  }
  final header = lines.first.split('|');
  final rows = <Map<String, String>>[];
  for (final line in lines.skip(1)) {
    if (line.isEmpty || line.startsWith('File Creation Time')) {
      continue;
    }
    final parts = line.split('|');
    if (parts.length != header.length) {
      continue;
    }
    rows.add({
      for (var i = 0; i < header.length; i++) header[i]: parts[i].trim(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Download helpers.
// ---------------------------------------------------------------------------

// Downloads a URL into the cache directory, or reuses the cached copy when
// one exists and --refresh was not passed. In --offline mode the cached copy
// is required.
Future<String> _cachedDownload({
  required HttpClient client,
  required Directory cacheDir,
  required String fileName,
  required String url,
  required bool offline,
  required bool refresh,
  String? userAgent,
}) async {
  final file = File('${cacheDir.path}${Platform.pathSeparator}$fileName');
  if (await file.exists() && !refresh) {
    stdout.writeln('Using cached $fileName.');
    return file.readAsString();
  }
  if (offline) {
    throw StateError('Offline mode, but ${file.path} is missing.');
  }
  stdout.writeln('Downloading $url ...');
  final body = await _httpGet(client, url, userAgent: userAgent);
  await file.writeAsString(body);
  return body;
}

// One GET with a small number of polite retries. Retries back off two, four,
// then eight seconds, and give up after five attempts.
Future<String> _httpGet(
  HttpClient client,
  String url, {
  String? userAgent,
}) async {
  Object? lastError;
  for (var attempt = 1; attempt <= 5; attempt++) {
    try {
      final request = await client.getUrl(Uri.parse(url));
      if (userAgent != null) {
        request.headers.set(HttpHeaders.userAgentHeader, userAgent);
      }
      final response = await request.close();
      if (response.statusCode == 200) {
        return response.transform(utf8.decoder).join();
      }
      // Drain so the connection can be reused.
      await response.drain<void>();
      if (response.statusCode == 404) {
        throw const HttpException('404');
      }
      lastError = HttpException('HTTP ${response.statusCode} for $url');
    } on HttpException catch (error) {
      if (error.message == '404') {
        rethrow;
      }
      lastError = error;
    } on IOException catch (error) {
      lastError = error;
    }
    await Future<void>.delayed(Duration(seconds: 2 << (attempt - 1)));
  }
  throw StateError('Failed to fetch $url after 5 attempts: $lastError');
}

// ---------------------------------------------------------------------------
// SEC SIC classification.
// ---------------------------------------------------------------------------

// Loads the on-disk SIC cache, fetches whatever is missing from SEC EDGAR,
// and appends the new answers to the cache so the next run is instant. Four
// download workers share one pacing gate that spaces request starts 140
// milliseconds apart, which holds the whole process near seven requests per
// second -- comfortably inside the SEC's published ten-per-second ceiling.
Future<Map<int, SicRecord>> _loadOrFetchSicRecords({
  required HttpClient client,
  required Directory cacheDir,
  required List<int> ciks,
  required bool offline,
}) async {
  final cacheFile = File(
    '${cacheDir.path}${Platform.pathSeparator}sic_by_cik.ndjson',
  );
  final known = <int, SicRecord>{};
  if (await cacheFile.exists()) {
    for (final line in await cacheFile.readAsLines()) {
      if (line.trim().isEmpty) {
        continue;
      }
      final entry = jsonDecode(line) as Map<String, dynamic>;
      known[entry['cik'] as int] = SicRecord(
        (entry['sic'] as String?) ?? '',
        (entry['desc'] as String?) ?? '',
      );
    }
  }
  final missing = ciks.where((cik) => !known.containsKey(cik)).toList();
  stdout.writeln(
    'SIC cache: ${known.length} cached, ${missing.length} to fetch.',
  );
  if (missing.isEmpty) {
    return known;
  }
  if (offline) {
    stdout.writeln('Offline mode: the missing ones stay Unclassified.');
    return known;
  }

  final sink = cacheFile.openWrite(mode: FileMode.append);
  var nextAllowedStart = DateTime.now();
  Future<void> pace() async {
    while (true) {
      final now = DateTime.now();
      if (!now.isBefore(nextAllowedStart)) {
        nextAllowedStart = now.add(const Duration(milliseconds: 140));
        return;
      }
      await Future<void>.delayed(nextAllowedStart.difference(now));
    }
  }

  var cursor = 0;
  var done = 0;
  var failures = 0;
  Future<void> worker() async {
    while (true) {
      if (cursor >= missing.length) {
        return;
      }
      final cik = missing[cursor++];
      final padded = cik.toString().padLeft(10, '0');
      final url = 'https://data.sec.gov/submissions/CIK$padded.json';
      SicRecord? record;
      for (var attempt = 1; attempt <= 4; attempt++) {
        await pace();
        try {
          final body = await _httpGet(client, url, userAgent: kSecUserAgent);
          final parsed = jsonDecode(body) as Map<String, dynamic>;
          record = SicRecord(
            (parsed['sic'] as String?) ?? '',
            (parsed['sicDescription'] as String?) ?? '',
          );
          break;
        } on HttpException catch (error) {
          if (error.message == '404') {
            // The SEC has no submissions file for this company. Cache the
            // miss so it is not re-asked on every run.
            record = SicRecord('', '');
            break;
          }
          await Future<void>.delayed(Duration(seconds: 2 << attempt));
        } catch (_) {
          await Future<void>.delayed(Duration(seconds: 2 << attempt));
        }
      }
      if (record == null) {
        // A transient failure is NOT cached, so the next run retries it.
        failures++;
      } else {
        known[cik] = record;
        sink.writeln(
          jsonEncode({
            'cik': cik,
            'sic': record.sic,
            'desc': record.description,
          }),
        );
      }
      done++;
      if (done % 250 == 0 || done == missing.length) {
        stdout.writeln('  SIC fetch progress: $done/${missing.length}');
        await sink.flush();
      }
    }
  }

  await Future.wait([worker(), worker(), worker(), worker()]);
  await sink.flush();
  await sink.close();
  if (failures > 0) {
    stdout.writeln(
      '  $failures SIC lookups failed after retries; those names stay '
      'Unclassified this run and will be retried on the next run.',
    );
  }
  return known;
}

// Rolls a four-digit SIC industry code up to one of the sector names the app
// already understands (the same strings the backend's sector benchmark map,
// sector breadth, and EDGAR sector-adjusted ranks key on). The ranges follow
// the SEC's own SIC division structure. Anything unknown returns
// Unclassified, which the backend treats as benchmark-to-SPY.
String _sectorForSic(String sicText) {
  final sic = int.tryParse(sicText.trim());
  if (sic == null || sic <= 0) {
    return 'Unclassified';
  }
  if (sic < 1000) {
    // Agriculture, forestry, and fishing: crop and livestock producers.
    return 'Consumer Staples';
  }
  if (sic < 1200) {
    return 'Materials'; // Metal mining.
  }
  if (sic < 1400) {
    return 'Energy'; // Coal, oil, and gas extraction.
  }
  if (sic < 1500) {
    return 'Materials'; // Quarrying and nonmetallic minerals.
  }
  if (sic < 1800) {
    return 'Industrials'; // Construction.
  }
  if (sic < 2000) {
    return 'Unclassified'; // Range not assigned by the SEC.
  }
  if (sic < 2200) {
    return 'Consumer Staples'; // Food, beverages, and tobacco.
  }
  if (sic < 2400) {
    return 'Consumer Discretionary'; // Textiles and apparel.
  }
  if (sic < 2500) {
    return 'Materials'; // Lumber and wood.
  }
  if (sic < 2600) {
    return 'Consumer Discretionary'; // Furniture.
  }
  if (sic < 2700) {
    return 'Materials'; // Paper.
  }
  if (sic < 2800) {
    return 'Communications'; // Printing and publishing.
  }
  if (sic >= 2830 && sic < 2840) {
    return 'Healthcare'; // Drugs, diagnostics, and biologicals.
  }
  if (sic < 2900) {
    return 'Materials'; // Chemicals other than drugs.
  }
  if (sic < 3000) {
    return 'Energy'; // Petroleum refining.
  }
  if (sic < 3100) {
    return 'Materials'; // Rubber and plastics.
  }
  if (sic < 3200) {
    return 'Consumer Discretionary'; // Leather goods.
  }
  if (sic < 3300) {
    return 'Materials'; // Stone, clay, and glass.
  }
  if (sic < 3400) {
    return 'Materials'; // Primary metals.
  }
  if (sic < 3500) {
    return 'Industrials'; // Fabricated metal products.
  }
  if (sic >= 3570 && sic < 3580) {
    return 'Technology'; // Computer and office equipment.
  }
  if (sic < 3600) {
    return 'Industrials'; // Industrial machinery.
  }
  if (sic < 3700) {
    return 'Technology'; // Electronics and semiconductors.
  }
  if (sic < 3720) {
    return 'Consumer Discretionary'; // Motor vehicles.
  }
  if (sic < 3800) {
    return 'Industrials'; // Aircraft, ships, rail, and defense.
  }
  if (sic >= 3840 && sic < 3860) {
    return 'Healthcare'; // Medical and dental instruments.
  }
  if (sic < 3900) {
    return 'Technology'; // Measurement and control instruments.
  }
  if (sic < 4000) {
    return 'Consumer Discretionary'; // Toys, jewelry, and miscellany.
  }
  if (sic < 4800) {
    return 'Industrials'; // Railroads, trucking, air, and shipping.
  }
  if (sic < 4900) {
    return 'Communications'; // Telephone, broadcasting, and cable.
  }
  if (sic < 5000) {
    return 'Utilities'; // Electric, gas, water, and sanitary.
  }
  if (sic < 5200) {
    return 'Industrials'; // Wholesale distribution.
  }
  if (sic >= 5400 && sic < 5500) {
    return 'Consumer Staples'; // Grocery stores.
  }
  if (sic >= 5900 && sic < 5920) {
    return 'Consumer Staples'; // Drug stores.
  }
  if (sic < 6000) {
    return 'Consumer Discretionary'; // All other retail.
  }
  if (sic == 6770) {
    return 'Speculative Growth'; // Blank checks, meaning SPAC shells.
  }
  if (sic == 6798) {
    return 'Real Estate'; // Real estate investment trusts.
  }
  if (sic >= 6500 && sic < 6600) {
    return 'Real Estate'; // Real estate operators and agents.
  }
  if (sic < 6800) {
    return 'Financials'; // Banks, brokers, insurance, and funds.
  }
  if (sic < 7000) {
    return 'Unclassified'; // Range not assigned by the SEC.
  }
  if (sic < 7200) {
    return 'Consumer Discretionary'; // Hotels and lodging.
  }
  if (sic == 7372) {
    return 'Software'; // Prepackaged software.
  }
  if (sic >= 7370 && sic < 7380) {
    return 'Technology'; // Computer programming and data services.
  }
  if (sic < 7500) {
    return 'Industrials'; // Business services.
  }
  if (sic < 7800) {
    return 'Consumer Discretionary'; // Auto repair and misc repair.
  }
  if (sic < 7900) {
    return 'Communications'; // Movies and recorded media.
  }
  if (sic < 8000) {
    return 'Consumer Discretionary'; // Amusement and recreation.
  }
  if (sic < 8100) {
    return 'Healthcare'; // Hospitals and health services.
  }
  if (sic >= 8200 && sic < 8300) {
    return 'Consumer Discretionary'; // Education services.
  }
  if (sic == 8731) {
    return 'Healthcare'; // Commercial physical research: mostly biotechs.
  }
  if (sic < 9000) {
    return 'Industrials'; // Engineering, accounting, and other services.
  }
  return 'Unclassified';
}

// Tidies an SEC sicDescription for display: trims and collapses whitespace.
String _cleanIndustry(String description) {
  return description.trim().replaceAll(RegExp(r'\s+'), ' ');
}

// ---------------------------------------------------------------------------
// Dart emission.
// ---------------------------------------------------------------------------

String _escape(String value) =>
    value.replaceAll(r'\', r'\\').replaceAll("'", r"\'");

String _emitDart({
  required List<ListingCandidate> keptStocks,
  required List<ListingCandidate> keptEtfs,
}) {
  // Stocks group into one bucket per sector-and-industry pair so the
  // industry label (which is display-only) stays meaningful.
  final stockGroups = <String, List<ListingCandidate>>{};
  for (final stock in keptStocks) {
    stockGroups
        .putIfAbsent('${stock.sector}|${stock.industry}', () => [])
        .add(stock);
  }

  // ETFs group by issuer family; funds outside the major families share one
  // catch-all bucket.
  final etfGroups = <String, List<ListingCandidate>>{};
  for (final etf in keptEtfs) {
    final issuer = _etfIssuerLabel(etf.name) ?? 'Other issuers';
    etfGroups.putIfAbsent(issuer, () => []).add(etf);
  }

  final buffer = StringBuffer()
    ..writeln('// GENERATED FILE - DO NOT EDIT BY HAND.')
    ..writeln('//')
    ..writeln(
      '// Emitted by tool/generate_expanded_universe.dart on '
      '${DateTime.now().toIso8601String().substring(0, 10)} from free,',
    )
    ..writeln('// official sources: the Nasdaq Trader symbol directories')
    ..writeln('// (nasdaqlisted.txt and otherlisted.txt) and SEC EDGAR')
    ..writeln('// (company_tickers.json plus per-company submissions files')
    ..writeln('// for SIC industry codes). No API key is involved.')
    ..writeln('//')
    ..writeln('// Regenerate with, from the repository root:')
    ..writeln('//')
    ..writeln('//   dart run tool/generate_expanded_universe.dart')
    ..writeln('//')
    ..writeln('// The hand-curated catalog in default_symbol_universe.dart')
    ..writeln('// always wins on conflict: the generator excludes every')
    ..writeln('// symbol that already appears there, so nothing here can')
    ..writeln('// shadow a curated entry.')
    ..writeln('//')
    ..writeln(
      '// Contents: ${keptStocks.length} common stocks and '
      '${keptEtfs.length} ETFs, all with neutral (zero) biases.',
    )
    ..writeln()
    ..writeln("import 'default_symbol_universe.dart';")
    ..writeln()
    ..writeln('/// Generated buckets appended after the hand-built catalog in')
    ..writeln('/// default_symbol_universe.dart.')
    ..writeln('const List<DefaultSymbolBucket> kGeneratedSymbolBuckets = [');

  void writeBucket({
    required String sector,
    required String industry,
    required bool isEtf,
    required List<String> symbols,
  }) {
    final template = kSectorTemplateTickers[sector] ?? 'MSFT';
    buffer
      ..writeln('  DefaultSymbolBucket(')
      ..writeln("    sector: '${_escape(sector)}',")
      ..writeln("    industry: '${_escape(industry)}',")
      ..writeln("    templateTicker: '$template',");
    if (isEtf) {
      buffer.writeln('    isEtf: true,');
    }
    buffer.writeln('    symbols: [');
    final line = StringBuffer('     ');
    for (final symbol in symbols) {
      final piece = " '$symbol',";
      if (line.length + piece.length > 78) {
        buffer.writeln(line);
        line
          ..clear()
          ..write('     ');
      }
      line.write(piece);
    }
    if (line.length > 5) {
      buffer.writeln(line);
    }
    buffer
      ..writeln('    ],')
      ..writeln('  ),');
  }

  final stockKeys = stockGroups.keys.toList()..sort();
  for (final key in stockKeys) {
    final group = stockGroups[key]!
      ..sort((a, b) => a.symbol.compareTo(b.symbol));
    final parts = key.split('|');
    writeBucket(
      sector: parts[0],
      industry: parts[1],
      isEtf: false,
      symbols: [for (final stock in group) stock.symbol],
    );
  }
  final etfKeys = etfGroups.keys.toList()..sort();
  for (final key in etfKeys) {
    final group = etfGroups[key]!..sort((a, b) => a.symbol.compareTo(b.symbol));
    writeBucket(
      sector: 'ETF / Macro',
      industry: key == 'Other issuers'
          ? 'Generated catalog: other issuers'
          : 'Generated catalog: $key funds',
      isEtf: true,
      symbols: [for (final etf in group) etf.symbol],
    );
  }

  buffer.writeln('];');
  return buffer.toString();
}
