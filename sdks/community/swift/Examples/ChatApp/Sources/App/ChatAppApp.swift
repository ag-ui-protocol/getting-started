// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import SwiftUI

@main
struct ChatAppApp: App {
    @StateObject private var store = ChatAppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}
