import 'dart:convert';

class PortfolioHolding {
  PortfolioHolding({
    required String ticker,
    required this.shares,
    required this.addedAt,
    this.averageCostBasis,
    this.currentPrice,
    this.currentValue,
    this.note,
  }) : ticker = normalizePortfolioTicker(ticker);

  final String ticker;
  final double shares;
  final double? averageCostBasis;
  final double? currentPrice;
  final double? currentValue;
  final String? note;
  final DateTime addedAt;

  double? get effectivePrice =>
      currentPrice ?? (currentValue != null ? currentValue! / shares : null);

  PortfolioHolding copyWith({
    String? ticker,
    double? shares,
    double? averageCostBasis,
    double? currentPrice,
    double? currentValue,
    String? note,
    DateTime? addedAt,
  }) {
    return PortfolioHolding(
      ticker: ticker ?? this.ticker,
      shares: shares ?? this.shares,
      averageCostBasis: averageCostBasis ?? this.averageCostBasis,
      currentPrice: currentPrice ?? this.currentPrice,
      currentValue: currentValue ?? this.currentValue,
      note: note ?? this.note,
      addedAt: addedAt ?? this.addedAt,
    );
  }

  Map<String, dynamic> toJson() => {
    'ticker': ticker,
    'shares': shares,
    'averageCostBasis': averageCostBasis,
    'currentPrice': currentPrice,
    'currentValue': currentValue,
    'note': note,
    'addedAt': addedAt.toIso8601String(),
  };

  factory PortfolioHolding.fromJson(Map<String, dynamic> json) {
    return PortfolioHolding(
      ticker: json['ticker'] as String? ?? '',
      shares: _readDouble(json['shares']) ?? 0,
      averageCostBasis: _readDouble(json['averageCostBasis']),
      currentPrice: _readDouble(json['currentPrice']),
      currentValue: _readDouble(json['currentValue']),
      note: json['note'] as String?,
      addedAt:
          DateTime.tryParse(json['addedAt'] as String? ?? '') ?? DateTime.now(),
    );
  }
}

class PortfolioState {
  const PortfolioState({required this.holdings, this.cashBalance});

  static const empty = PortfolioState(
    holdings: <PortfolioHolding>[],
    cashBalance: null,
  );

  static const _unset = Object();

  final List<PortfolioHolding> holdings;
  final double? cashBalance;

  bool get hasCashBalance => cashBalance != null && cashBalance! > 0;

  bool get isEmpty => holdings.isEmpty && !hasCashBalance;

  double get trackedHoldingsValue =>
      holdings.fold(0, (sum, holding) => sum + (holding.currentValue ?? 0));

  double? get trackedAccountValue {
    final holdingsValue = trackedHoldingsValue;
    if (hasCashBalance && holdingsValue > 0) {
      return cashBalance! + holdingsValue;
    }
    if (hasCashBalance) {
      return cashBalance;
    }
    return holdingsValue > 0 ? holdingsValue : null;
  }

  Set<String> get tickers => holdings.map((holding) => holding.ticker).toSet();

  PortfolioState copyWith({
    List<PortfolioHolding>? holdings,
    Object? cashBalance = _unset,
  }) {
    return PortfolioState(
      holdings: holdings ?? this.holdings,
      cashBalance: identical(cashBalance, _unset)
          ? this.cashBalance
          : cashBalance as double?,
    );
  }

  PortfolioHolding? holdingByTicker(String ticker) {
    final normalized = normalizePortfolioTicker(ticker);
    for (final holding in holdings) {
      if (holding.ticker == normalized) {
        return holding;
      }
    }
    return null;
  }

  PortfolioState upsertHolding(PortfolioHolding holding) {
    final normalized = normalizePortfolioTicker(holding.ticker);
    final next = [
      for (final existing in holdings)
        if (existing.ticker != normalized) existing,
      holding,
    ]..sort((a, b) => a.ticker.compareTo(b.ticker));
    return PortfolioState(holdings: next, cashBalance: cashBalance);
  }

  PortfolioState removeHolding(String ticker) {
    final normalized = normalizePortfolioTicker(ticker);
    return PortfolioState(
      holdings: holdings
          .where((holding) => holding.ticker != normalized)
          .toList(),
      cashBalance: cashBalance,
    );
  }

  String toJson() {
    return jsonEncode({
      'holdings': holdings.map((holding) => holding.toJson()).toList(),
      'cashBalance': cashBalance,
    });
  }

  factory PortfolioState.fromJson(String raw) {
    if (raw.isEmpty) {
      return PortfolioState.empty;
    }

    final decoded = jsonDecode(raw);
    final holdingsJson = decoded is Map<String, dynamic>
        ? decoded['holdings']
        : null;
    if (holdingsJson is! List<dynamic>) {
      return PortfolioState.empty;
    }

    return PortfolioState(
      holdings:
          holdingsJson
              .whereType<Map<String, dynamic>>()
              .map(PortfolioHolding.fromJson)
              .where(
                (holding) => holding.ticker.isNotEmpty && holding.shares > 0,
              )
              .toList()
            ..sort((a, b) => a.ticker.compareTo(b.ticker)),
      cashBalance: _readDouble(
        decoded is Map<String, dynamic> ? decoded['cashBalance'] : null,
      ),
    );
  }
}

class PortfolioImportResult {
  const PortfolioImportResult({
    required this.state,
    required this.importedCount,
    required this.skippedRows,
    this.importedCashBalance,
  });

  final PortfolioState state;
  final int importedCount;
  final int skippedRows;
  final double? importedCashBalance;

  bool get importedAny =>
      importedCount > 0 ||
      (importedCashBalance != null && importedCashBalance! > 0);
}

PortfolioImportResult parsePortfolioHoldingsCsv(
  String raw, {
  PortfolioState existing = PortfolioState.empty,
  DateTime? importedAt,
}) {
  final rows = _parseCsvRows(raw);
  if (rows.isEmpty) {
    return PortfolioImportResult(
      state: existing,
      importedCount: 0,
      skippedRows: 0,
    );
  }

  final hasHeader = _looksLikeHeader(rows.first);
  final header = hasHeader ? _headerMap(rows.first) : <String, int>{};
  final dataRows = hasHeader ? rows.skip(1) : rows;
  var state = existing;
  var importedCount = 0;
  var skippedRows = 0;
  var importedCashBalance = 0.0;
  var sawCashRow = false;
  final addedAt = importedAt ?? DateTime.now();

  for (final row in dataRows) {
    if (row.every((cell) => cell.trim().isEmpty)) {
      continue;
    }

    final tickerText = _cellValue(row, header, const [
      'symbol',
      'ticker',
      'tickersymbol',
    ], fallbackIndex: 0);
    final sharesText = _cellValue(row, header, const [
      'quantity',
      'qty',
      'shares',
      'sharequantity',
      'currentquantity',
    ], fallbackIndex: 1);
    final ticker = normalizePortfolioTicker(tickerText ?? '');
    final currentValueText = _cellValue(row, header, const [
      'currentvalue',
      'marketvalue',
      'positionvalue',
      'value',
    ]);
    final currentValue = _parseLooseNumber(currentValueText);
    final currentPriceText = _cellValue(row, header, const [
      'lastprice',
      'price',
      'currentprice',
      'marketprice',
    ]);
    final currentPrice = _parseLooseNumber(currentPriceText);
    final descriptionText = _cellValue(row, header, const [
      'description',
      'securitydescription',
      'name',
    ]);
    final typeText = _cellValue(row, header, const [
      'type',
      'securitytype',
      'assettype',
    ]);
    final shares = _parseLooseNumber(sharesText);

    if (_looksLikeCashRow(
      ticker: ticker,
      description: descriptionText,
      type: typeText,
      shares: shares,
      currentValue: currentValue,
    )) {
      if (currentValue != null && currentValue > 0) {
        importedCashBalance += currentValue;
        sawCashRow = true;
      } else {
        skippedRows++;
      }
      continue;
    }

    if (ticker.isEmpty || shares == null || shares <= 0) {
      skippedRows++;
      continue;
    }

    final averageCostText = _cellValue(row, header, const [
      'averagecostbasis',
      'averagecost',
      'avgcost',
      'costbasispershare',
      'costper share',
      'unitcost',
    ], fallbackIndex: hasHeader ? null : 2);
    var averageCostBasis = _parseLooseNumber(averageCostText);

    final totalCostText = _cellValue(row, header, const [
      'costbasistotal',
      'totalcostbasis',
      'totalcost',
      'costbasis',
    ]);
    final totalCost = _parseLooseNumber(totalCostText);
    if (averageCostBasis == null && totalCost != null) {
      averageCostBasis = totalCost / shares;
    }

    state = state.upsertHolding(
      PortfolioHolding(
        ticker: ticker,
        shares: shares,
        averageCostBasis: averageCostBasis,
        currentPrice: currentPrice,
        currentValue: currentValue,
        addedAt: addedAt,
      ),
    );
    importedCount++;
  }

  if (sawCashRow) {
    state = state.copyWith(cashBalance: importedCashBalance);
  }

  return PortfolioImportResult(
    state: state,
    importedCount: importedCount,
    skippedRows: skippedRows,
    importedCashBalance: sawCashRow ? importedCashBalance : null,
  );
}

String normalizePortfolioTicker(String raw) {
  final compact = raw.trim().toUpperCase().split(RegExp(r'\s+')).first;
  return compact.replaceAll(RegExp(r'[^A-Z0-9.\-]'), '');
}

List<List<String>> _parseCsvRows(String raw) {
  final rows = <List<String>>[];
  var row = <String>[];
  final field = StringBuffer();
  var inQuotes = false;

  void closeField() {
    row.add(field.toString().trim());
    field.clear();
  }

  void closeRow() {
    closeField();
    if (row.any((cell) => cell.isNotEmpty)) {
      rows.add(row);
    }
    row = <String>[];
  }

  for (var index = 0; index < raw.length; index++) {
    final char = raw[index];
    if (char == '"') {
      if (inQuotes && index + 1 < raw.length && raw[index + 1] == '"') {
        field.write('"');
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char == ',' && !inQuotes) {
      closeField();
      continue;
    }

    if ((char == '\n' || char == '\r') && !inQuotes) {
      if (char == '\r' && index + 1 < raw.length && raw[index + 1] == '\n') {
        index++;
      }
      closeRow();
      continue;
    }

    field.write(char);
  }

  if (field.isNotEmpty || row.isNotEmpty) {
    closeRow();
  }

  return rows;
}

bool _looksLikeHeader(List<String> row) {
  final normalized = row.map(_normalizeHeader).toSet();
  return normalized.contains('symbol') ||
      normalized.contains('ticker') ||
      normalized.contains('quantity') ||
      normalized.contains('shares');
}

Map<String, int> _headerMap(List<String> row) {
  final headers = <String, int>{};
  for (var index = 0; index < row.length; index++) {
    final key = _normalizeHeader(row[index]);
    if (key.isNotEmpty) {
      headers[key] = index;
    }
  }
  return headers;
}

String? _cellValue(
  List<String> row,
  Map<String, int> header,
  List<String> candidates, {
  int? fallbackIndex,
}) {
  for (final candidate in candidates.map(_normalizeHeader)) {
    final index = header[candidate];
    if (index != null && index < row.length) {
      return row[index];
    }
  }

  if (fallbackIndex != null && fallbackIndex < row.length) {
    return row[fallbackIndex];
  }
  return null;
}

String _normalizeHeader(String value) {
  return value.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
}

bool _looksLikeCashRow({
  required String ticker,
  required String? description,
  required String? type,
  required double? shares,
  required double? currentValue,
}) {
  final normalizedTicker = ticker.toUpperCase();
  final normalizedDescription = (description ?? '').toUpperCase();
  final normalizedType = (type ?? '').toUpperCase();

  final looksLikeCashTicker =
      normalizedTicker.startsWith('SPAXX') || normalizedTicker.contains('CASH');
  final looksLikeCashDescription =
      normalizedDescription.contains('MONEY MARKET') ||
      normalizedDescription.contains('CASH RESERVE');
  final looksLikeCashType = normalizedType.contains('CASH');
  final missingShareCount = shares == null || shares <= 0;

  return currentValue != null &&
      currentValue > 0 &&
      (looksLikeCashTicker ||
          looksLikeCashDescription ||
          (looksLikeCashType && missingShareCount));
}

double? _parseLooseNumber(String? raw) {
  if (raw == null) {
    return null;
  }
  final trimmed = raw.trim();
  if (trimmed.isEmpty || trimmed == '--' || trimmed.toLowerCase() == 'n/a') {
    return null;
  }
  final isNegative = trimmed.startsWith('(') && trimmed.endsWith(')');
  final cleaned = trimmed.replaceAll(RegExp(r'[\$,%()+\s]'), '');
  final parsed = double.tryParse(cleaned.replaceAll(',', ''));
  if (parsed == null) {
    return null;
  }
  return isNegative ? -parsed : parsed;
}

double? _readDouble(Object? value) {
  if (value is num) {
    return value.toDouble();
  }
  if (value is String) {
    return _parseLooseNumber(value);
  }
  return null;
}
