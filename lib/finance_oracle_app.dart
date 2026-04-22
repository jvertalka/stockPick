import 'package:flutter/material.dart';

import 'src/data/market_intelligence_repository.dart';
import 'src/data/provider_market_repository.dart';
import 'src/models/intelligence_app_state.dart';
import 'src/presentation/home_shell.dart';
import 'src/theme/app_theme.dart';

class FinanceOracleApp extends StatefulWidget {
  const FinanceOracleApp({super.key, MarketIntelligenceRepository? repository})
    : _repository = repository ?? const _DefaultRepository();

  final MarketIntelligenceRepository _repository;

  @override
  State<FinanceOracleApp> createState() => _FinanceOracleAppState();
}

class _FinanceOracleAppState extends State<FinanceOracleApp> {
  late Future<IntelligenceAppState> _stateFuture;
  bool _isRefreshing = false;

  @override
  void initState() {
    super.initState();
    _stateFuture = widget._repository.loadState();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Finance Oracle',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.build(),
      home: FutureBuilder<IntelligenceAppState>(
        future: _stateFuture,
        builder: (context, snapshot) {
          if (snapshot.hasError && !snapshot.hasData) {
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

          return HomeShell(
            state: snapshot.data!,
            isRefreshing: _isRefreshing,
            onRefresh: _refreshState,
          );
        },
      ),
    );
  }

  Future<void> _refreshState() async {
    if (_isRefreshing) {
      return;
    }

    setState(() {
      _isRefreshing = true;
    });
    final future = widget._repository.refreshState();
    setState(() {
      _stateFuture = future;
    });

    try {
      await future;
    } finally {
      if (mounted) {
        setState(() {
          _isRefreshing = false;
        });
      }
    }
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
    return ProviderMarketRepository.fixtureBacked().loadState();
  }

  @override
  Future<IntelligenceAppState> refreshState() {
    return loadState();
  }
}
