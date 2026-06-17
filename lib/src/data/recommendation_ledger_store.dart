import 'package:shared_preferences/shared_preferences.dart';

import '../models/recommendation_ledger_models.dart';

abstract class RecommendationLedgerStore {
  Future<RecommendationLedger> load();

  Future<void> save(RecommendationLedger ledger);
}

class SharedPreferencesRecommendationLedgerStore
    implements RecommendationLedgerStore {
  SharedPreferencesRecommendationLedgerStore({
    this.preferencesKey = 'finance_oracle_recommendation_ledger_v1',
  });

  final String preferencesKey;

  @override
  Future<RecommendationLedger> load() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return RecommendationLedger.empty;
    }
    return RecommendationLedger.fromJson(raw);
  }

  @override
  Future<void> save(RecommendationLedger ledger) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferencesKey, ledger.toJson());
  }
}
