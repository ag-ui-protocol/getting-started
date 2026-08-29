package com.agui.core.types

import kotlinx.serialization.modules.SerializersModule

/**
 * Serializers module for AG-UI data types.
 *
 * All polymorphic AG-UI hierarchies — [BaseEvent], [Message], and [RunFinishedOutcome] —
 * are `sealed` classes. kotlinx.serialization enumerates the subtypes of a sealed
 * hierarchy at compile time and generates the polymorphic serializer automatically,
 * so they must NOT be registered here via `polymorphic { subclass(...) }`. Manual
 * registration is only required for open (non-sealed) polymorphism.
 *
 * This module is intentionally empty and retained as a stable `serializersModule`
 * anchor for [AgUiJson] should any future non-sealed polymorphic type need registering.
 *
 * See: https://github.com/Kotlin/kotlinx.serialization/blob/master/docs/polymorphism.md#sealed-classes
 */
val AgUiSerializersModule by lazy {
    SerializersModule {
        // Intentionally empty — all AG-UI polymorphic types are sealed and auto-resolve.
    }
}
