import org.jetbrains.kotlin.gradle.targets.js.dsl.ExperimentalWasmDsl

plugins {
    kotlin("multiplatform") version "2.2.20"
    kotlin("plugin.serialization") version "2.2.20"
    id("com.android.library") version "8.2.2"
    id("io.gitlab.arturbosch.detekt") version "1.23.4"
    id("maven-publish")
    id("signing")
}

// Group and version from gradle.properties
group = findProperty("group")?.toString() ?: "com.ag-ui.community"
version = "0.4.1"

repositories {
    google()
    mavenCentral()
}

kotlin {
    // Configure source directory
    sourceSets.all {
        kotlin.srcDir("library/src/$name/kotlin")
        resources.srcDir("library/src/$name/resources")
    }
    
    // Configure K2 compiler options
    targets.configureEach {
        compilations.configureEach {
            compileTaskProvider.configure {
                compilerOptions {
                    // Enable K2 compiler features
                    freeCompilerArgs.add("-Xexpect-actual-classes")
                    freeCompilerArgs.add("-Xopt-in=kotlin.RequiresOptIn")
                    freeCompilerArgs.add("-Xopt-in=kotlinx.coroutines.ExperimentalCoroutinesApi")
                    freeCompilerArgs.add("-Xopt-in=kotlinx.serialization.ExperimentalSerializationApi")
                    languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                    apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                }
            }
        }
    }
    
    // Android target
    androidTarget {
        compilations.all {
            kotlinOptions {
                jvmTarget = "11"
            }
        }
        publishLibraryVariants("release")
    }
    
    // iOS targets
    iosX64()
    iosArm64()
    iosSimulatorArm64()
    
    // JVM target
    jvm {
        compilations.all {
            kotlinOptions {
                jvmTarget = "11"
            }
        }
        testRuns["test"].executionTask.configure {
            useJUnitPlatform()
        }
    }
    
    // JS target (future)
    // js(IR) {
    //     browser()
    //     nodejs()
    // }
    
    // Native targets (future)
    // macosX64()
    // macosArm64()
    // linuxX64()
    // mingwX64()
    
    sourceSets {
        val commonMain by getting {
            dependencies {
                // Ktor for networking
                implementation("io.ktor:ktor-client-core:3.2.4")
                implementation("io.ktor:ktor-client-content-negotiation:3.2.4")
                implementation("io.ktor:ktor-serialization-kotlinx-json:3.2.4")
                implementation("io.ktor:ktor-client-logging:3.2.4")
                
                // Kotlinx libraries
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
                implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.6.2")
                
                // Logging
                implementation("io.github.microutils:kotlin-logging:3.0.5")
            }
        }
        
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
                implementation("io.ktor:ktor-client-mock:3.2.4")
            }
        }
        
        val androidMain by getting {
            dependencies {
                implementation("io.ktor:ktor-client-android:3.2.4")
                implementation("org.slf4j:slf4j-android:1.7.36")
            }
        }
        
        val iosX64Main by getting
        val iosArm64Main by getting
        val iosSimulatorArm64Main by getting
        val iosMain by creating {
            dependsOn(commonMain)
            iosX64Main.dependsOn(this)
            iosArm64Main.dependsOn(this)
            iosSimulatorArm64Main.dependsOn(this)
            
            dependencies {
                implementation("io.ktor:ktor-client-darwin:3.2.4")
            }
        }
        
        val jvmMain by getting {
            dependencies {
                implementation("io.ktor:ktor-client-java:3.2.4")
                implementation("org.slf4j:slf4j-simple:2.0.9")
            }
        }
    }
}

android {
    namespace = "com.agui.agui4k"
    compileSdk = 34
    
    defaultConfig {
        minSdk = 21
    }
    
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    
    sourceSets {
        getByName("main") {
            manifest.srcFile("library/src/androidMain/AndroidManifest.xml")
        }
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

// Detekt configuration
detekt {
    buildUponDefaultConfig = true
    config.setFrom("$projectDir/detekt-config.yml")
    baseline = file("$projectDir/detekt-baseline.xml")
    source.setFrom("library/src")
}

tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
    reports {
        html.required.set(true)
        xml.required.set(true)
        txt.required.set(true)
        sarif.required.set(true)
        md.required.set(true)
    }
}
