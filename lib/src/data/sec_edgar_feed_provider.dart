import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;

import '../models/intelligence_app_state.dart';
import 'market_feed_provider.dart';
import 'raw_market_data.dart';

class SecEdgarFeedProvider {
  SecEdgarFeedProvider({
    required this.symbols,
    this.corsProxyPrefix = '',
    this.requestTimeout = const Duration(seconds: 3),
    http.Client? client,
  }) : _client = client ?? http.Client();

  final List<String> symbols;
  final String corsProxyPrefix;
  final Duration requestTimeout;
  final http.Client _client;
  Future<Map<String, SecTickerEntry>>? _tickerMapFuture;

  Future<FeedSlice<SecEdgarUniverse>> probe({int maxSymbols = 5}) async {
    final loaded = <String, SecCompanyEvidence>{};
    for (final symbol in symbols.take(maxSymbols)) {
      final evidence = await loadCompanyEvidence(symbol);
      if (evidence != null) {
        loaded[symbol.toUpperCase()] = evidence;
      }
    }

    return FeedSlice(
      name: 'SEC EDGAR fundamentals',
      source: 'sec-edgar',
      asOf: DateTime.now(),
      data: SecEdgarUniverse(evidenceBySymbol: loaded),
      availability: loaded.isEmpty
          ? FeedAvailability.missing
          : FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.eventDriven,
      detail: loaded.isEmpty
          ? 'SEC EDGAR did not return company facts from this environment. Browser builds may need kCorsProxyPrefix because data.sec.gov does not support browser CORS.'
          : 'SEC EDGAR supplied official XBRL fundamentals and filing activity for ${loaded.length} symbols.',
    );
  }

  Future<SecCompanyEvidence?> loadCompanyEvidence(String symbol) async {
    final normalized = symbol.trim().toUpperCase();
    if (normalized.isEmpty) {
      return null;
    }

    try {
      final tickerMap = await _loadTickerMap();
      final entry = tickerMap[normalized];
      if (entry == null) {
        return null;
      }

      final cik = entry.paddedCik;
      final factsResponse = await _getJson(
        'https://data.sec.gov/api/xbrl/companyfacts/CIK$cik.json',
      );
      if (factsResponse == null) {
        return null;
      }
      final submissionsResponse = await _getJson(
        'https://data.sec.gov/submissions/CIK$cik.json',
      );

      final facts = SecFactBook(factsResponse);
      final filings = submissionsResponse == null
          ? const <SecRecentFiling>[]
          : _readRecentFilings(submissionsResponse);
      return _buildEvidence(
        symbol: normalized,
        cik: cik,
        companyName: entry.title,
        facts: facts,
        filings: filings,
      );
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, SecTickerEntry>> _loadTickerMap() {
    return _tickerMapFuture ??= _fetchTickerMap();
  }

  Future<Map<String, SecTickerEntry>> _fetchTickerMap() async {
    final decoded = await _getJson(
      'https://www.sec.gov/files/company_tickers.json',
    );
    if (decoded == null) {
      return const <String, SecTickerEntry>{};
    }
    return decoded.map((_, value) {
      final item = value as Map<String, dynamic>;
      final ticker = (item['ticker'] as String? ?? '').toUpperCase();
      return MapEntry(
        ticker,
        SecTickerEntry(
          cik: _asInt(item['cik_str']),
          ticker: ticker,
          title: (item['title'] as String?) ?? ticker,
        ),
      );
    })..removeWhere((key, value) => key.isEmpty || value.cik <= 0);
  }

  Future<Map<String, dynamic>?> _getJson(String rawUrl) async {
    final response = await _client
        .get(
          Uri.parse(_wrap(rawUrl)),
          headers: const {'Accept': 'application/json'},
        )
        .timeout(requestTimeout);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null;
    }
    final decoded = jsonDecode(response.body);
    return decoded is Map<String, dynamic> ? decoded : null;
  }

  SecCompanyEvidence _buildEvidence({
    required String symbol,
    required String cik,
    required String companyName,
    required SecFactBook facts,
    required List<SecRecentFiling> filings,
  }) {
    final revenues = facts.usdSeries(const [
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'SalesRevenueNet',
    ]);
    final netIncome = facts.usdSeries(const ['NetIncomeLoss']);
    final operatingCashFlow = facts.usdSeries(const [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ]);
    final capex = facts.usdSeries(const [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'CapitalExpenditures',
    ]);
    final assets = facts.usdSeries(const ['Assets']);
    final liabilities = facts.usdSeries(const ['Liabilities']);
    final debt = facts.usdSeries(const [
      'LongTermDebtAndFinanceLeaseObligations',
      'LongTermDebtNoncurrent',
      'LongTermDebtCurrent',
      'ShortTermBorrowings',
    ]);
    final shares = facts.shareSeries(const [
      'EntityCommonStockSharesOutstanding',
      'CommonStocksIncludingAdditionalPaidInCapital',
    ]);

    final revenueGrowth = _growthPct(revenues);
    final latestRevenue = revenues.lastOrNull?.value;
    final latestNetIncome = netIncome.lastOrNull?.value;
    final marginPct =
        latestRevenue == null ||
            latestRevenue.abs() < 1 ||
            latestNetIncome == null
        ? null
        : latestNetIncome / latestRevenue * 100;

    final latestCfo = operatingCashFlow.lastOrNull?.value;
    final latestCapex = capex.lastOrNull?.value;
    final latestFcf = latestCfo == null
        ? null
        : latestCfo - (latestCapex == null ? 0 : latestCapex.abs());
    final fcfMarginPct =
        latestRevenue == null || latestRevenue.abs() < 1 || latestFcf == null
        ? null
        : latestFcf / latestRevenue * 100;

    final latestAssets = assets.lastOrNull?.value;
    final latestLiabilities = liabilities.lastOrNull?.value;
    final latestDebt = debt.lastOrNull?.value;
    final debtAssetPct =
        latestAssets == null || latestAssets.abs() < 1 || latestDebt == null
        ? null
        : latestDebt.abs() / latestAssets.abs() * 100;
    final liabilityAssetPct =
        latestAssets == null ||
            latestAssets.abs() < 1 ||
            latestLiabilities == null
        ? null
        : latestLiabilities.abs() / latestAssets.abs() * 100;
    final shareGrowth = _growthPct(shares);

    final statementFilings = filings
        .where((filing) => filing.form == '10-Q' || filing.form == '10-K')
        .toList();
    final latestStatementDate = statementFilings.firstOrNull?.filed;
    final eightKCount = _recentFormCount(
      filings,
      '8-K',
      const Duration(days: 45),
    );
    final form4Count = _recentFormCount(filings, '4', const Duration(days: 60));

    final revenueScore = _scoreHigh(revenueGrowth, scale: 1.35, neutral: 50);
    final marginScore = _scoreHigh(marginPct, scale: 2.1, neutral: 50);
    final fcfScore = _scoreHigh(fcfMarginPct, scale: 2.4, neutral: 50);
    final leverageScore = _scoreLow(debtAssetPct, scale: 1.15, neutral: 58);
    final liabilityScore = _scoreLow(
      liabilityAssetPct,
      scale: 0.95,
      neutral: 58,
    );
    final dilutionScore = shareGrowth == null
        ? 55.0
        : (58 - shareGrowth * 4).clamp(10, 90).toDouble();
    final filingFreshness = _filingFreshnessScore(latestStatementDate);
    final eventRisk = _eventRiskScore(
      eightKCount: eightKCount,
      form4Count: form4Count,
      latestStatementDate: latestStatementDate,
    );

    return SecCompanyEvidence(
      symbol: symbol,
      cik: cik,
      companyName: companyName,
      revenueTrendScore: revenueScore,
      marginTrendScore: marginScore,
      freeCashFlowTrendScore: fcfScore,
      balanceSheetScore: _average([leverageScore, liabilityScore]),
      profitabilityScore: _average([marginScore, fcfScore]),
      leverageQualityScore: leverageScore,
      earningsStabilityScore: _average([
        marginScore,
        filingFreshness,
        dilutionScore,
      ]),
      dilutionScore: dilutionScore,
      filingFreshnessScore: filingFreshness,
      eventRiskScore: eventRisk,
      latestFilingDate: filings.firstOrNull?.filed,
      latestStatementDate: latestStatementDate,
      recent8KCount: eightKCount,
      recentForm4Count: form4Count,
      detail:
          'Revenue trend ${revenueScore.round()}, margin ${marginScore.round()}, FCF ${fcfScore.round()}, balance sheet ${_average([leverageScore, liabilityScore]).round()}, filing risk ${eventRisk.round()}.',
    );
  }

  List<SecRecentFiling> _readRecentFilings(Map<String, dynamic> decoded) {
    final recent = decoded['filings'] is Map<String, dynamic>
        ? (decoded['filings'] as Map<String, dynamic>)['recent']
        : null;
    if (recent is! Map<String, dynamic>) {
      return const <SecRecentFiling>[];
    }
    final forms = _asStringList(recent['form']);
    final filed = _asStringList(recent['filingDate']);
    final accession = _asStringList(recent['accessionNumber']);
    final count = math.min(forms.length, filed.length);
    final filings = <SecRecentFiling>[];
    for (var index = 0; index < count; index++) {
      final date = DateTime.tryParse(filed[index]);
      if (date == null) {
        continue;
      }
      filings.add(
        SecRecentFiling(
          form: forms[index],
          filed: date,
          accessionNumber: index < accession.length ? accession[index] : '',
        ),
      );
    }
    filings.sort((a, b) => b.filed.compareTo(a.filed));
    return filings;
  }

  int _recentFormCount(
    List<SecRecentFiling> filings,
    String form,
    Duration window,
  ) {
    final cutoff = DateTime.now().subtract(window);
    return filings
        .where((filing) => filing.form == form && filing.filed.isAfter(cutoff))
        .length;
  }

  double _eventRiskScore({
    required int eightKCount,
    required int form4Count,
    required DateTime? latestStatementDate,
  }) {
    final stalePenalty = latestStatementDate == null
        ? 14
        : DateTime.now().difference(latestStatementDate).inDays > 150
        ? 12
        : 0;
    return (34 + eightKCount * 8 + form4Count * 3 + stalePenalty)
        .clamp(0, 100)
        .toDouble();
  }

  double _filingFreshnessScore(DateTime? filed) {
    if (filed == null) {
      return 42;
    }
    final age = DateTime.now().difference(filed).inDays;
    if (age <= 75) {
      return 78;
    }
    if (age <= 120) {
      return 66;
    }
    if (age <= 180) {
      return 52;
    }
    return 38;
  }

  double? _growthPct(List<SecFact> facts) {
    if (facts.length < 2) {
      return null;
    }
    final latest = facts.last.value;
    final previous = facts[facts.length - 2].value;
    if (previous.abs() < 1) {
      return null;
    }
    return (latest / previous - 1) * 100;
  }

  double _scoreHigh(
    double? value, {
    required double scale,
    required double neutral,
  }) {
    if (value == null || !value.isFinite) {
      return neutral;
    }
    return (50 + value * scale).clamp(0, 100).toDouble();
  }

  double _scoreLow(
    double? value, {
    required double scale,
    required double neutral,
  }) {
    if (value == null || !value.isFinite) {
      return neutral;
    }
    return (90 - value * scale).clamp(0, 100).toDouble();
  }

  double _average(List<double> values) {
    final usable = values.where((value) => value.isFinite).toList();
    if (usable.isEmpty) {
      return 50;
    }
    return usable.reduce((a, b) => a + b) / usable.length;
  }

  String _wrap(String url) {
    if (corsProxyPrefix.isEmpty) {
      return url;
    }
    if (corsProxyPrefix.contains('url=')) {
      return '$corsProxyPrefix${Uri.encodeComponent(url)}';
    }
    return '$corsProxyPrefix$url';
  }
}

class SecEdgarFundamentalsOverlayStockProvider implements StockSignalProvider {
  SecEdgarFundamentalsOverlayStockProvider({
    required StockSignalProvider fallbackProvider,
    required SecEdgarFeedProvider secProvider,
    this.maxSymbolsPerRefresh = 5,
    this.overlayTimeout = const Duration(seconds: 10),
  }) : _fallbackProvider = fallbackProvider,
       _secProvider = secProvider;

  final StockSignalProvider _fallbackProvider;
  final SecEdgarFeedProvider _secProvider;
  final int maxSymbolsPerRefresh;
  final Duration overlayTimeout;

  @override
  Future<FeedSlice<List<RawStockSignal>>> loadStockSignals() async {
    final fallback = await _fallbackProvider.loadStockSignals();
    final candidates = fallback.data.take(maxSymbolsPerRefresh).toList();
    final evidenceEntries =
        await Future.wait(
          candidates.map((stock) async {
            return MapEntry(
              stock.ticker,
              await _secProvider.loadCompanyEvidence(stock.ticker),
            );
          }),
        ).timeout(
          overlayTimeout,
          onTimeout: () => const <MapEntry<String, SecCompanyEvidence?>>[],
        );
    final evidenceByTicker = <String, SecCompanyEvidence>{
      for (final entry in evidenceEntries)
        if (entry.value != null) entry.key: entry.value!,
    };
    final enriched = <RawStockSignal>[];
    var overlayCount = 0;
    for (final stock in fallback.data) {
      final evidence = evidenceByTicker[stock.ticker];
      if (evidence == null) {
        enriched.add(stock);
        continue;
      }
      enriched.add(_overlay(stock, evidence));
      overlayCount++;
    }

    if (overlayCount == 0) {
      return fallback;
    }

    return FeedSlice(
      name: fallback.name,
      source: '${fallback.source}+sec-edgar',
      asOf: DateTime.now(),
      data: enriched,
      availability: FeedAvailability.connected,
      refreshCadence: FeedRefreshCadence.eventDriven,
      detail:
          '${fallback.detail} SEC EDGAR overlaid official filing-derived fundamentals and event risk for $overlayCount symbols.',
    );
  }

  RawStockSignal _overlay(RawStockSignal stock, SecCompanyEvidence evidence) {
    final fundamentalDirection = _average([
      evidence.revenueTrendScore,
      evidence.marginTrendScore,
      evidence.freeCashFlowTrendScore,
      evidence.filingFreshnessScore,
    ]);
    final eventDrag = (evidence.eventRiskScore - 50).clamp(0, 50).toDouble();

    return stock.copyWith(
      earningsRevisions: _blend(
        stock.earningsRevisions,
        fundamentalDirection,
        0.40,
      ),
      earningsSurprise: _blend(
        stock.earningsSurprise,
        fundamentalDirection,
        0.35,
      ),
      marginTrend: _blend(stock.marginTrend, evidence.marginTrendScore, 0.72),
      revenueTrend: _blend(
        stock.revenueTrend,
        evidence.revenueTrendScore,
        0.72,
      ),
      freeCashFlowTrend: _blend(
        stock.freeCashFlowTrend,
        evidence.freeCashFlowTrendScore,
        0.78,
      ),
      balanceSheetQuality: _blend(
        stock.balanceSheetQuality,
        evidence.balanceSheetScore,
        0.78,
      ),
      profitability: _blend(
        stock.profitability,
        evidence.profitabilityScore,
        0.72,
      ),
      leverageQuality: _blend(
        stock.leverageQuality,
        evidence.leverageQualityScore,
        0.78,
      ),
      earningsStability: _blend(
        stock.earningsStability,
        evidence.earningsStabilityScore,
        0.62,
      ),
      revisionDelta: _blend(stock.revisionDelta, fundamentalDirection, 0.35),
      eventPremium: _blend(stock.eventPremium, evidence.eventRiskScore, 0.38),
      putSkewChange: _blend(
        stock.putSkewChange,
        stock.putSkewChange + eventDrag,
        0.18,
      ),
      downsideProtectionDemand: _blend(
        stock.downsideProtectionDemand,
        stock.downsideProtectionDemand + eventDrag,
        0.22,
      ),
      volatilityRepricing: _blend(
        stock.volatilityRepricing,
        stock.volatilityRepricing + eventDrag,
        0.20,
      ),
      expectedStability: _blend(
        stock.expectedStability,
        _average([
          evidence.balanceSheetScore,
          evidence.earningsStabilityScore,
          100 - evidence.eventRiskScore,
        ]),
        0.48,
      ),
    );
  }

  double _blend(double oldValue, double newValue, double weight) {
    return (oldValue * (1 - weight) + newValue * weight)
        .clamp(0, 100)
        .toDouble();
  }

  double _average(List<double> values) {
    if (values.isEmpty) {
      return 50;
    }
    return values.reduce((a, b) => a + b) / values.length;
  }
}

class SecFactBook {
  const SecFactBook(this.decoded);

  final Map<String, dynamic> decoded;

  List<SecFact> usdSeries(List<String> concepts) {
    return _series(concepts, const ['USD']);
  }

  List<SecFact> shareSeries(List<String> concepts) {
    return _series(concepts, const ['shares', 'USD']);
  }

  List<SecFact> _series(List<String> concepts, List<String> units) {
    final usGaap = decoded['facts'] is Map<String, dynamic>
        ? (decoded['facts'] as Map<String, dynamic>)['us-gaap']
        : null;
    if (usGaap is! Map<String, dynamic>) {
      return const <SecFact>[];
    }

    final facts = <SecFact>[];
    for (final concept in concepts) {
      final conceptNode = usGaap[concept];
      if (conceptNode is! Map<String, dynamic>) {
        continue;
      }
      final unitNode = conceptNode['units'];
      if (unitNode is! Map<String, dynamic>) {
        continue;
      }
      for (final unit in units) {
        final rows = unitNode[unit];
        if (rows is! List<dynamic>) {
          continue;
        }
        for (final row in rows) {
          if (row is! Map<String, dynamic>) {
            continue;
          }
          final form = row['form'] as String? ?? '';
          if (!_isStatementForm(form)) {
            continue;
          }
          final value = _asDouble(row['val']);
          final end = DateTime.tryParse(row['end'] as String? ?? '');
          final filed = DateTime.tryParse(row['filed'] as String? ?? '');
          if (value == null || end == null) {
            continue;
          }
          facts.add(
            SecFact(
              concept: concept,
              value: value,
              end: end,
              filed: filed,
              form: form,
            ),
          );
        }
      }
    }

    final byEndAndForm = <String, SecFact>{};
    for (final fact in facts) {
      final key = '${fact.concept}:${fact.form}:${fact.end.toIso8601String()}';
      final existing = byEndAndForm[key];
      if (existing == null ||
          (fact.filed != null &&
              existing.filed != null &&
              fact.filed!.isAfter(existing.filed!))) {
        byEndAndForm[key] = fact;
      }
    }

    return byEndAndForm.values.toList()
      ..sort((left, right) => left.end.compareTo(right.end));
  }

  bool _isStatementForm(String form) {
    return form == '10-Q' || form == '10-K' || form == '20-F' || form == '40-F';
  }
}

class SecTickerEntry {
  const SecTickerEntry({
    required this.cik,
    required this.ticker,
    required this.title,
  });

  final int cik;
  final String ticker;
  final String title;

  String get paddedCik => cik.toString().padLeft(10, '0');
}

class SecFact {
  const SecFact({
    required this.concept,
    required this.value,
    required this.end,
    required this.form,
    this.filed,
  });

  final String concept;
  final double value;
  final DateTime end;
  final DateTime? filed;
  final String form;
}

class SecRecentFiling {
  const SecRecentFiling({
    required this.form,
    required this.filed,
    required this.accessionNumber,
  });

  final String form;
  final DateTime filed;
  final String accessionNumber;
}

class SecCompanyEvidence {
  const SecCompanyEvidence({
    required this.symbol,
    required this.cik,
    required this.companyName,
    required this.revenueTrendScore,
    required this.marginTrendScore,
    required this.freeCashFlowTrendScore,
    required this.balanceSheetScore,
    required this.profitabilityScore,
    required this.leverageQualityScore,
    required this.earningsStabilityScore,
    required this.dilutionScore,
    required this.filingFreshnessScore,
    required this.eventRiskScore,
    required this.recent8KCount,
    required this.recentForm4Count,
    required this.detail,
    this.latestFilingDate,
    this.latestStatementDate,
  });

  final String symbol;
  final String cik;
  final String companyName;
  final double revenueTrendScore;
  final double marginTrendScore;
  final double freeCashFlowTrendScore;
  final double balanceSheetScore;
  final double profitabilityScore;
  final double leverageQualityScore;
  final double earningsStabilityScore;
  final double dilutionScore;
  final double filingFreshnessScore;
  final double eventRiskScore;
  final int recent8KCount;
  final int recentForm4Count;
  final String detail;
  final DateTime? latestFilingDate;
  final DateTime? latestStatementDate;
}

class SecEdgarUniverse {
  const SecEdgarUniverse({required this.evidenceBySymbol});

  final Map<String, SecCompanyEvidence> evidenceBySymbol;
}

extension _LastOrNull<T> on List<T> {
  T? get lastOrNull => isEmpty ? null : last;
  T? get firstOrNull => isEmpty ? null : first;
}

double? _asDouble(dynamic value) {
  if (value is num) {
    return value.toDouble();
  }
  if (value is String) {
    return double.tryParse(value);
  }
  return null;
}

int _asInt(dynamic value) {
  if (value is num) {
    return value.toInt();
  }
  if (value is String) {
    return int.tryParse(value) ?? 0;
  }
  return 0;
}

List<String> _asStringList(dynamic value) {
  if (value is! List<dynamic>) {
    return const <String>[];
  }
  return value.map((item) => item?.toString() ?? '').toList();
}
