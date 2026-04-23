import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:finance_app/src/data/market_snapshot_archive.dart';
import 'package:finance_app/src/data/raw_market_data.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test(
    'archive stores point-in-time snapshots without duplicating the same as-of source pair',
    () async {
      final archive = SharedPreferencesMarketSnapshotArchive(maxSnapshots: 4);
      final snapshot = RawMarketState(
        asOf: DateTime(2026, 4, 22, 9, 42),
        environment: const RawMarketEnvironment(
          indexTrend: 80,
          realizedVolatility: 55,
          impliedVolatility: 57,
          creditStress: 31,
          financialConditions: 72,
          growthLeadership: 77,
          defensiveLeadership: 34,
          smallCapLeadership: 46,
          inflationPressure: 39,
          breadth: 70,
          advanceDecline: 68,
          newHighLow: 65,
          percentAboveMajorAverages: 73,
          equalWeightConfirmation: 58,
          sectorParticipation: 69,
          correlation: 44,
          dispersion: 61,
          volumeConcentration: 63,
        ),
        styles: const [
          RawStyleSignal(
            style: 'Large-cap growth',
            strength: 81,
            note: 'Fixture style sample.',
          ),
        ],
        sectors: const [
          RawSectorSignal(
            sector: 'Technology',
            strength: 88,
            breadth: 79,
            revisions: 82,
            sponsorship: 86,
            crowdingRisk: 74,
            note: 'Fixture sector sample.',
          ),
        ],
        stocks: const [
          RawStockSignal(
            ticker: 'NVDA',
            company: 'NVIDIA',
            sector: 'Technology',
            industry: 'Semiconductors',
            shortTrend: 91,
            mediumTrend: 89,
            longTrend: 86,
            residualStrength: 90,
            momentumPersistence: 85,
            breakoutQuality: 84,
            volumeSupport: 83,
            earningsRevisions: 87,
            earningsSurprise: 82,
            marginTrend: 79,
            revenueTrend: 88,
            freeCashFlowTrend: 81,
            balanceSheetQuality: 82,
            profitability: 91,
            leverageQuality: 80,
            earningsStability: 76,
            valuationSupport: 61,
            crowdingRisk: 77,
            impliedVolRank: 69,
            realizedImpliedGap: 7,
            putSkewChange: 62,
            eventPremium: 58,
            downsideProtectionDemand: 65,
            relativeStrengthDelta: 63,
            sectorBreadthDelta: 61,
            revisionDelta: 67,
            priceResponse: 59,
            abnormalDownVolume: 41,
            volatilityRepricing: 47,
            peerLeadership: 76,
            growthExposure: 92,
            defensiveExposure: 16,
            creditSensitivity: 33,
            rateSensitivity: 70,
            expectedStability: 72,
            peers: [],
          ),
        ],
      );

      final firstSave = await archive.saveSnapshot(
        snapshot,
        source: 'fixture-research-repository',
      );
      final secondSave = await archive.saveSnapshot(
        snapshot,
        source: 'fixture-research-repository',
      );
      final snapshots = await archive.loadSnapshots();

      expect(firstSave.snapshotCount, 1);
      expect(secondSave.snapshotCount, 1);
      expect(secondSave.latestSnapshotAsOf, snapshot.asOf);
      expect(secondSave.sources, contains('fixture-research-repository'));
      expect(snapshots, hasLength(1));
    },
  );
}
