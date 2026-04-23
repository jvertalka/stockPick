import 'alpha_vantage_store.dart';
import 'alpha_vantage_store_factory_stub.dart'
    if (dart.library.io) 'alpha_vantage_store_factory_io.dart'
    as platform;

AlphaVantageLocalStore createDefaultAlphaVantageLocalStore({
  String preferencesKey = 'finance_oracle_alpha_vantage_store_v1',
}) {
  return platform.createPlatformAlphaVantageLocalStore(
    preferencesKey: preferencesKey,
  );
}
