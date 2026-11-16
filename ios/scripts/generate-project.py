"""Generate a dependency-free Xcode project. Run after adding/removing Swift files."""
from pathlib import Path
import hashlib
import json
import plistlib

root = Path(__file__).resolve().parents[1]
objects = {}

def ident(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()

def add(object_key, isa, **values):
    key = ident(object_key)
    objects[key] = dict(isa=isa, **values)
    return key

sources = sorted(root.glob("Starpost/**/*.swift"))
resources = [root / "Starpost/Assets.xcassets", root / "Starpost/PrivacyInfo.xcprivacy"]
source_builds, resource_builds, refs = [], [], []
for path in sources + resources + [root / "Starpost/Info.plist"]:
    relative = path.relative_to(root).as_posix()
    typ = "sourcecode.swift" if path.suffix == ".swift" else "folder.assetcatalog" if path.suffix == ".xcassets" else "text.plist.xml"
    ref = add(relative, "PBXFileReference", lastKnownFileType=typ, path=relative, sourceTree="<group>")
    refs.append(ref)
    if path in sources + resources:
        build = add("build:" + relative, "PBXBuildFile", fileRef=ref)
        (source_builds if path in sources else resource_builds).append(build)
product = add("product", "PBXFileReference", explicitFileType="wrapper.application", path="Starpost.app", sourceTree="BUILT_PRODUCTS_DIR", includeInIndex=0)
products = add("products", "PBXGroup", children=[product], name="Products", sourceTree="<group>")
main = add("main", "PBXGroup", children=refs + [products], sourceTree="<group>")
phases = [
    add("sources", "PBXSourcesBuildPhase", buildActionMask=2147483647, files=source_builds, runOnlyForDeploymentPostprocessing=0),
    add("frameworks", "PBXFrameworksBuildPhase", buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0),
    add("resources", "PBXResourcesBuildPhase", buildActionMask=2147483647, files=resource_builds, runOnlyForDeploymentPostprocessing=0),
]
project_configs, target_configs = [], []
for config in ["Debug", "Release"]:
    shared = dict(CLANG_ENABLE_MODULES="YES", CLANG_ENABLE_OBJC_ARC="YES", SDKROOT="iphoneos", IPHONEOS_DEPLOYMENT_TARGET="17.0", SWIFT_VERSION="5.0", ENABLE_USER_SCRIPT_SANDBOXING="YES", DEBUG_INFORMATION_FORMAT="dwarf" if config == "Debug" else "dwarf-with-dsym")
    project_configs.append(add("project:" + config, "XCBuildConfiguration", name=config, buildSettings=shared))
    settings = dict(PRODUCT_BUNDLE_IDENTIFIER="io.starpost.ios", PRODUCT_NAME="$(TARGET_NAME)", INFOPLIST_FILE="Starpost/Info.plist", GENERATE_INFOPLIST_FILE="NO", CURRENT_PROJECT_VERSION="1", MARKETING_VERSION="0.1.0", TARGETED_DEVICE_FAMILY="1,2", SUPPORTED_PLATFORMS="iphoneos iphonesimulator", SUPPORTS_MACCATALYST="NO", SWIFT_EMIT_LOC_STRINGS="YES", ASSETCATALOG_COMPILER_APPICON_NAME="AppIcon", LD_RUNPATH_SEARCH_PATHS=["$(inherited)", "@executable_path/Frameworks"], SWIFT_OPTIMIZATION_LEVEL="-Onone" if config == "Debug" else "-O", CODE_SIGN_STYLE="Automatic", SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG" if config == "Debug" else "", ENABLE_TESTABILITY="YES" if config == "Debug" else "NO")
    target_configs.append(add("target:" + config, "XCBuildConfiguration", name=config, buildSettings=settings))
def config_list(name, configs):
    return add(name, "XCConfigurationList", buildConfigurations=configs, defaultConfigurationIsVisible=0, defaultConfigurationName="Release")
target = add("target", "PBXNativeTarget", name="Starpost", productName="Starpost", productType="com.apple.product-type.application", productReference=product, buildConfigurationList=config_list("target-configs", target_configs), buildPhases=phases, buildRules=[], dependencies=[])
project = add("project", "PBXProject", attributes={"LastUpgradeCheck": "1600", "BuildIndependentTargetsInParallel": "YES"}, buildConfigurationList=config_list("project-configs", project_configs), compatibilityVersion="Xcode 14.0", developmentRegion="zh_CN", knownRegions=["zh_CN", "en", "Base"], mainGroup=main, productRefGroup=products, projectDirPath="", projectRoot="", targets=[target])

def encode(value, depth=0):
    if isinstance(value, dict):
        return "{\n" + "".join("\t" * (depth + 1) + json.dumps(k) + " = " + encode(v, depth + 1) + ";\n" for k, v in value.items()) + "\t" * depth + "}"
    if isinstance(value, list):
        return "(" + ", ".join(encode(v, depth) for v in value) + ")"
    return json.dumps(value, ensure_ascii=False)

out = root / "Starpost.xcodeproj"
out.mkdir(exist_ok=True)
project_doc = {"archiveVersion": 1, "classes": {}, "objectVersion": 56, "objects": objects, "rootObject": project}
(out / "project.pbxproj").write_text("// !$*UTF8*$!\n" + encode(project_doc) + "\n", encoding="utf-8")
schemes = out / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Starpost.app" BlueprintName="Starpost" ReferencedContainer="container:Starpost.xcodeproj"/>'
(schemes / "Starpost.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''', encoding="utf-8")

data_types = ["NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeName", "NSPrivacyCollectedDataTypeEmailAddress", "NSPrivacyCollectedDataTypeOtherUserContent", "NSPrivacyCollectedDataTypePhotosorVideos", "NSPrivacyCollectedDataTypeAudioData"]
privacy = {"NSPrivacyTracking": False, "NSPrivacyTrackingDomains": [], "NSPrivacyAccessedAPITypes": [], "NSPrivacyCollectedDataTypes": [{"NSPrivacyCollectedDataType": t, "NSPrivacyCollectedDataTypeLinked": True, "NSPrivacyCollectedDataTypeTracking": False, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]} for t in data_types]}
(root / "Starpost/PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps(privacy))
print(f"Generated Xcode project: {len(sources)} Swift files")
