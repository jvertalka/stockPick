import '../models/intelligence_app_state.dart';

abstract class MarketIntelligenceRepository {
  Future<IntelligenceAppState> loadState();

  Future<IntelligenceAppState> refreshState() => loadState();
}
