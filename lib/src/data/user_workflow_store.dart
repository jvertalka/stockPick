import 'package:shared_preferences/shared_preferences.dart';

import '../models/workflow_models.dart';

abstract class UserWorkflowStore {
  Future<WorkflowState> load();

  Future<void> save(WorkflowState state);
}

class SharedPreferencesUserWorkflowStore implements UserWorkflowStore {
  SharedPreferencesUserWorkflowStore({
    this.preferencesKey = 'finance_oracle_workflow_state_v1',
  });

  final String preferencesKey;

  @override
  Future<WorkflowState> load() async {
    final preferences = await SharedPreferences.getInstance();
    final raw = preferences.getString(preferencesKey);
    if (raw == null || raw.isEmpty) {
      return WorkflowState.empty;
    }
    return WorkflowState.fromJson(raw);
  }

  @override
  Future<void> save(WorkflowState state) async {
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(preferencesKey, state.toJson());
  }
}
