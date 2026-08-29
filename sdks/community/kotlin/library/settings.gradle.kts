rootProject.name = "ag-ui-kotlin-sdk"

pluginManagement {
    repositories {
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

// Enable version catalog
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

// Include all modules
include(":kotlin-core")
include(":kotlin-client")
include(":kotlin-tools")
include(":kotlin-encoder")

// Map module directories to artifact names
project(":kotlin-core").projectDir = file("core")
project(":kotlin-client").projectDir = file("client")
project(":kotlin-tools").projectDir = file("tools")
project(":kotlin-encoder").projectDir = file("encoder")

