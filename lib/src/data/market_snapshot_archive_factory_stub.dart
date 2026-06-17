import 'market_snapshot_archive.dart';

MarketSnapshotArchive createPlatformMarketSnapshotArchive({
  required String preferencesKey,
  required int maxSnapshots,
}) {
  return SharedPreferencesMarketSnapshotArchive(
    preferencesKey: preferencesKey,
    maxSnapshots: maxSnapshots,
  );
}
