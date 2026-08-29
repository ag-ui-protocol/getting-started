plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("maven-publish")
    id("signing")
}

// Group and version inherited from parent build.gradle.kts

repositories {
    google()
    mavenCentral()
}

kotlin {
    // Configure K2 compiler options (mirrors :kotlin-server / :kotlin-client)
    targets.configureEach {
        compilations.configureEach {
            compileTaskProvider.configure {
                compilerOptions {
                    freeCompilerArgs.add("-Xexpect-actual-classes")
                    freeCompilerArgs.add("-opt-in=kotlin.RequiresOptIn")
                    freeCompilerArgs.add("-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi")
                    freeCompilerArgs.add("-opt-in=kotlinx.serialization.ExperimentalSerializationApi")
                    languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
                    apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_1)
                }
            }
        }
    }

    // JVM target only: publishes a `kotlin-encoder-jvm` artifact (no Android/iOS, so
    // no Android SDK is needed to build or publish this module), mirroring how TS
    // ships `@ag-ui/encoder` and Python ships `ag_ui.encoder` as their own package.
    jvm {
        compilations.all {
            compileTaskProvider.configure {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
                }
            }
        }
        testRuns["test"].executionTask.configure {
            useJUnitPlatform()
        }
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                api(project(":kotlin-core"))

                implementation(libs.kotlinx.serialization.json)
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }

        val jvmMain by getting
        val jvmTest by getting
    }
}

// Publishing configuration
publishing {
    publications {
        withType<MavenPublication> {
            version = project.version.toString()
            pom {
                name.set("kotlin-encoder")
                description.set("Event encoder (SSE) for the Agent User Interaction Protocol")
                url.set("https://github.com/ag-ui-protocol/ag-ui")

                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }

                developers {
                    developer {
                        id.set("contextablemark")
                        name.set("Mark Fogle")
                        email.set("mark@contextable.com")
                    }
                }

                scm {
                    url.set("https://github.com/ag-ui-protocol/ag-ui")
                    connection.set("scm:git:git://github.com/ag-ui-protocol/ag-ui.git")
                    developerConnection.set("scm:git:ssh://github.com:ag-ui-protocol/ag-ui.git")
                }
            }
        }
    }
}

// Signing configuration
signing {
    val signingKey: String? by project
    val signingPassword: String? by project

    if (signingKey != null && signingPassword != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications)
    }
}

// JUnit Platform is configured in the `jvm { testRuns["test"] }` block above (and
// inherited from the root `subprojects { tasks.withType<Test> }`).

// KMP modules expose `jvmTest`/`allTests` rather than the plain `test` lifecycle
// task. Provide a `test` alias so `:kotlin-encoder:test` works like the plain-JVM
// modules.
tasks.register("test") {
    group = "verification"
    description = "Runs the JVM test suite (alias for jvmTest)."
    dependsOn("jvmTest")
}
