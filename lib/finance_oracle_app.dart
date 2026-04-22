import 'package:flutter/material.dart';

import 'src/data/fixture_market_repository.dart';
import 'src/data/market_intelligence_repository.dart';
import 'src/models/intelligence_app_state.dart';
import 'src/presentation/home_shell.dart';
import 'src/theme/app_theme.dart';

class FinanceOracleApp extends StatelessWidget {
  const FinanceOracleApp({super.key, MarketIntelligenceRepository? repository})
    : _repository = repository ?? const _DefaultRepository();

  final MarketIntelligenceRepository _repository;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Finance Oracle',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.build(),
      home: FutureBuilder<IntelligenceAppState>(
        future: _repository.loadState(),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return _StatusScaffold(
              title: 'Unable to load the intelligence layer',
              body:
                  'The app shell is available, but the repository failed to build the current market state. ${snapshot.error}',
            );
          }

          if (!snapshot.hasData) {
            return const _StatusScaffold(
              title: 'Building the market state',
              body:
                  'Loading the repository, evaluating the rules engine, and assembling the current dashboard.',
              loading: true,
            );
          }

          return HomeShell(state: snapshot.data!);
        },
      ),
    );
  }
}

class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({
    required this.title,
    required this.body,
    this.loading = false,
  });

  final String title;
  final String body;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(gradient: AppTheme.backgroundGradient),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (loading) ...[
                    const CircularProgressIndicator(),
                    const SizedBox(height: 20),
                  ],
                  Text(
                    title,
                    style: Theme.of(context).textTheme.headlineMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    body,
                    style: Theme.of(context).textTheme.bodyLarge,
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DefaultRepository implements MarketIntelligenceRepository {
  const _DefaultRepository();

  @override
  Future<IntelligenceAppState> loadState() {
    return FixtureMarketRepository().loadState();
  }
}
