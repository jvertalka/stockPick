import 'market_snapshot_archive.dart';
import 'market_snapshot_archive_factory_stub.dart'
    if (dart.library.io) 'market_snapshot_archive_factory_io.dart'
    as platform;

MarketSnapshotArchive createDefaultMarketSnapshotArchive({
  String preferencesKey = 'market_snapshot_archive_v1',
  int maxSnapshots = 240,
}) {
  return platform.createPlatformMarketSnapshotArchive(
    preferencesKey: preferencesKey,
    maxSnapshots: maxSnapshots,
  );
}
