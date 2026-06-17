import 'package:shared_preferences/shared_preferences.dart';

import '../models/app_settings_models.dart';

abstract class AppSettingsStore {
  Future<AppSettings> load();

  Future<void> save(AppSettings settings);
}

class SharedPreferencesAppSettingsStore implements AppSettingsStore {
  SharedPreferencesAppSettingsStore({
    this.preferencesKey = 'finance_oracle_app_settings_v1',
  });

  final String preferencesKey;

  @override
  Future<AppSettings> load() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return AppSettings.empty;
    }
    return AppSettings.fromJson(raw);
  }

  @override
  Future<void> save(AppSettings settings) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferencesKey, settings.toJson());
  }
}
