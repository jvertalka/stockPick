import 'package:shared_preferences/shared_preferences.dart';

import '../models/portfolio_models.dart';

abstract class PortfolioStore {
  Future<PortfolioState> load();

  Future<void> save(PortfolioState state);
}

class SharedPreferencesPortfolioStore implements PortfolioStore {
  SharedPreferencesPortfolioStore({
    this.preferencesKey = 'finance_oracle_portfolio_state_v1',
  });

  final String preferencesKey;

  @override
  Future<PortfolioState> load() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return PortfolioState.empty;
    }
    return PortfolioState.fromJson(raw);
  }

  @override
  Future<void> save(PortfolioState state) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferencesKey, state.toJson());
  }
}
