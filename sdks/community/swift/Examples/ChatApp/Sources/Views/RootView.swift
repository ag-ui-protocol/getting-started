// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: ChatAppStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                regularLayout
            } else {
                compactLayout
            }
        }
        // Agent form sheet
        .sheet(item: Binding(
            get: { store.formMode.map(FormSheetItem.init) },
            set: { newVal in if newVal == nil { store.dismissAgentForm() } }
        )) { item in
            AgentFormView(mode: item.mode)
                .environmentObject(store)
        }
        // Phase 5: ClawgUI enterprise pairing sheet.
        // Presented whenever pairingState != .idle; dismissed on success or user cancel.
        .sheet(isPresented: Binding(
            get: { store.state.clawgUIPairingState != .idle },
            set: { if !$0 { store.resetPairing() } }
        )) {
            ClawgUIPairingView(
                state: store.state.clawgUIPairingState,
                onConfirm: { store.confirmPairing() },
                onRetry: { store.retryPairing() },
                onDismiss: { store.resetPairing() }
            )
        }
        // Repository error alert
        .alert(
            "Error",
            isPresented: Binding(
                get: { store.repositoryError != nil },
                set: { _ in store.repositoryError = nil }
            )
        ) {
            Button("OK", role: .cancel) { store.repositoryError = nil }
        } message: {
            Text(store.repositoryError ?? "")
        }
        // Conversation error alert
        .alert(
            "Conversation Error",
            isPresented: Binding(
                get: { store.state.error != nil },
                set: { _ in store.dismissError() }
            )
        ) {
            Button("OK", role: .cancel) { store.dismissError() }
        } message: {
            Text(store.state.error ?? "")
        }
    }

    // MARK: - Layout variants

    private var regularLayout: some View {
        NavigationSplitView {
            AgentListView(
                agents: store.agents,
                selectedId: store.selectedAgentId,
                onSelect: { store.setActiveAgent(id: $0) },
                onAdd: store.presentCreateAgent,
                onEdit: store.presentEditAgent,
                onDelete: { store.deleteAgent(id: $0) }
            )
            .frame(minWidth: 280)
        } detail: {
            ChatView(state: store.state) { store.sendMessage($0) }
                .navigationTitle(store.state.activeAgent?.name ?? "Chat")
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: store.presentCreateAgent) {
                            Label("Add Agent", systemImage: "plus")
                        }
                    }
                }
        }
    }

    private var compactLayout: some View {
        NavigationStack {
            ChatView(state: store.state) { store.sendMessage($0) }
                .navigationTitle(store.state.activeAgent?.name ?? "Chat")
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Menu {
                            ForEach(store.agents) { agent in
                                Button {
                                    store.setActiveAgent(id: agent.id)
                                } label: {
                                    Label(
                                        agent.name,
                                        systemImage: store.selectedAgentId == agent.id
                                            ? "checkmark.circle.fill" : "circle"
                                    )
                                }
                            }
                            Divider()
                            Button(action: store.presentCreateAgent) {
                                Label("New Agent", systemImage: "plus.circle")
                            }
                        } label: {
                            Label("Agents", systemImage: "person.3.sequence")
                        }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: store.presentCreateAgent) {
                            Label("Add Agent", systemImage: "plus")
                        }
                    }
                }
        }
    }
}

// MARK: - Helpers

private struct FormSheetItem: Identifiable, Equatable {
    let mode: AgentFormMode

    var id: String {
        switch mode {
        case .create: return "create"
        case .edit(let c): return "edit-\(c.id)"
        }
    }

    static func == (lhs: FormSheetItem, rhs: FormSheetItem) -> Bool { lhs.id == rhs.id }
}
