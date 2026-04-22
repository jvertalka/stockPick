import 'dart:math' as math;

import '../data/raw_market_data.dart';
import '../models/intelligence_app_state.dart';
import 'market_intelligence_engine.dart';

class ValidationEngine {
  ValidationEngine({required MarketIntelligenceEngine engine})
    : _engine = engine;

  final MarketIntelligenceEngine _engine;

  ValidationReport validate(List<ValidationWindow> windows) {
    final allScores = <double>[];
    final allAlpha = <double>[];
    final topPickAlpha = <double>[];
    final topPickReturns = <double>[];
    final topPickDrawdowns = <double>[];

    for (final window in windows) {
      final evaluation = _engine.evaluate(window.marketState);
      final outcomeMap = {
        for (final outcome in window.outcomes) outcome.ticker: outcome,
      };

      for (final scored in evaluation.scoredStocks) {
        final outcome = outcomeMap[scored.raw.ticker];
        if (outcome == null) {
          continue;
        }
        allScores.add(scored.insight.opportunityScore);
        allAlpha.add(outcome.forwardReturn20d - outcome.sectorReturn20d);
      }

      final ranked =
          evaluation.scoredStocks
              .where((stock) => outcomeMap.containsKey(stock.raw.ticker))
              .toList()
            ..sort(
              (left, right) => right.insight.opportunityScore.compareTo(
                left.insight.opportunityScore,
              ),
            );

      for (final topPick in ranked.take(2)) {
        final outcome = outcomeMap[topPick.raw.ticker]!;
        topPickAlpha.add(outcome.forwardReturn20d - outcome.sectorReturn20d);
        topPickReturns.add(outcome.forwardReturn20d);
        topPickDrawdowns.add(outcome.maxDrawdown20d);
      }
    }

    final hitRate = topPickAlpha.isEmpty
        ? 0
        : topPickAlpha.where((alpha) => alpha > 0).length / topPickAlpha.length;
    final averageAlpha = _average(topPickAlpha);
    final averageReturn = _average(topPickReturns);
    final worstDrawdown = topPickDrawdowns.isEmpty
        ? 0.0
        : topPickDrawdowns.reduce((left, right) => math.min(left, right));
    final scoreCorrelation = _correlation(allScores, allAlpha);

    final verdict = switch ((hitRate, averageAlpha, scoreCorrelation)) {
      (>= 0.6, >= 1.5, >= 0.15) =>
        'The rules engine is directionally promising on fixture windows, but it is still far from production validation.',
      (>= 0.5, >= 0.5, _) =>
        'The engine shows some separation on fixture windows, though it still needs a real point-in-time test harness.',
      _ =>
        'The current validation is too thin to support confidence beyond UX prototyping.',
    };

    return ValidationReport(
      windowCount: windows.length,
      observationCount: allScores.length,
      hitRate: hitRate * 100,
      averageAlpha: averageAlpha,
      averageReturn: averageReturn,
      worstDrawdown: worstDrawdown,
      scoreCorrelation: scoreCorrelation,
      verdict: verdict,
    );
  }

  double _average(List<double> values) {
    if (values.isEmpty) {
      return 0;
    }
    return values.reduce((left, right) => left + right) / values.length;
  }

  double _correlation(List<double> xs, List<double> ys) {
    if (xs.length != ys.length || xs.length < 2) {
      return 0;
    }

    final meanX = _average(xs);
    final meanY = _average(ys);
    var numerator = 0.0;
    var sumSquaredX = 0.0;
    var sumSquaredY = 0.0;

    for (var index = 0; index < xs.length; index++) {
      final dx = xs[index] - meanX;
      final dy = ys[index] - meanY;
      numerator += dx * dy;
      sumSquaredX += dx * dx;
      sumSquaredY += dy * dy;
    }

    final denominator = math.sqrt(sumSquaredX * sumSquaredY);
    if (denominator == 0) {
      return 0;
    }
    return numerator / denominator;
  }
}
