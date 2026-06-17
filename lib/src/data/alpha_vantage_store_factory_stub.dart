import 'alpha_vantage_store.dart';

AlphaVantageLocalStore createPlatformAlphaVantageLocalStore({
  required String preferencesKey,
}) {
  return SharedPreferencesAlphaVantageLocalStore(
    preferencesKey: preferencesKey,
  );
}
