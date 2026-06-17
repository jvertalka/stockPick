import 'dart:convert';

enum WorkflowActionType {
  watchlistAdded,
  watchlistRemoved,
  savedIdeaAdded,
  savedIdeaRemoved,
  alertSubscribed,
  alertUnsubscribed,
  stockOpened,
}

extension WorkflowActionTypeLabel on WorkflowActionType {
  String get label => switch (this) {
    WorkflowActionType.watchlistAdded => 'Added to watchlist',
    WorkflowActionType.watchlistRemoved => 'Removed from watchlist',
    WorkflowActionType.savedIdeaAdded => 'Saved idea',
    WorkflowActionType.savedIdeaRemoved => 'Removed saved idea',
    WorkflowActionType.alertSubscribed => 'Subscribed to alert',
    WorkflowActionType.alertUnsubscribed => 'Removed alert',
    WorkflowActionType.stockOpened => 'Opened stock intelligence',
  };
}

class WorkflowActionRecord {
  const WorkflowActionRecord({
    required this.type,
    required this.ticker,
    required this.occurredAt,
    this.note,
  });

  final WorkflowActionType type;
  final String ticker;
  final DateTime occurredAt;
  final String? note;

  Map<String, dynamic> toJson() => {
    'type': type.name,
    'ticker': ticker,
    'occurredAt': occurredAt.toIso8601String(),
    'note': note,
  };

  factory WorkflowActionRecord.fromJson(Map<String, dynamic> json) {
    return WorkflowActionRecord(
      type: WorkflowActionType.values.firstWhere(
        (value) => value.name == json['type'],
      ),
      ticker: json['ticker'] as String,
      occurredAt: DateTime.parse(json['occurredAt'] as String),
      note: json['note'] as String?,
    );
  }
}

class WorkflowState {
  const WorkflowState({
    required this.watchlistTickers,
    required this.savedIdeas,
    required this.alertSubscriptions,
    required this.recentActions,
  });

  static const empty = WorkflowState(
    watchlistTickers: <String>{},
    savedIdeas: <String>{},
    alertSubscriptions: <String>{},
    recentActions: <WorkflowActionRecord>[],
  );

  final Set<String> watchlistTickers;
  final Set<String> savedIdeas;
  final Set<String> alertSubscriptions;
  final List<WorkflowActionRecord> recentActions;

  WorkflowState copyWith({
    Set<String>? watchlistTickers,
    Set<String>? savedIdeas,
    Set<String>? alertSubscriptions,
    List<WorkflowActionRecord>? recentActions,
  }) {
    return WorkflowState(
      watchlistTickers: watchlistTickers ?? this.watchlistTickers,
      savedIdeas: savedIdeas ?? this.savedIdeas,
      alertSubscriptions: alertSubscriptions ?? this.alertSubscriptions,
      recentActions: recentActions ?? this.recentActions,
    );
  }

  String toJson() {
    return jsonEncode({
      'watchlistTickers': watchlistTickers.toList()..sort(),
      'savedIdeas': savedIdeas.toList()..sort(),
      'alertSubscriptions': alertSubscriptions.toList()..sort(),
      'recentActions': recentActions.map((action) => action.toJson()).toList(),
    });
  }

  factory WorkflowState.fromJson(String raw) {
    if (raw.isEmpty) {
      return WorkflowState.empty;
    }
    final json = jsonDecode(raw) as Map<String, dynamic>;
    return WorkflowState(
      watchlistTickers:
          ((json['watchlistTickers'] as List<dynamic>? ?? const [])
                  .cast<String>())
              .toSet(),
      savedIdeas:
          ((json['savedIdeas'] as List<dynamic>? ?? const []).cast<String>())
              .toSet(),
      alertSubscriptions:
          ((json['alertSubscriptions'] as List<dynamic>? ?? const [])
                  .cast<String>())
              .toSet(),
      recentActions: (json['recentActions'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                WorkflowActionRecord.fromJson(item as Map<String, dynamic>),
          )
          .toList(),
    );
  }
}
