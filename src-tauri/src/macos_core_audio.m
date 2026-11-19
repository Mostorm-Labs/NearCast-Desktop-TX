#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AVFAudio/AVFAudio.h>
#import <unistd.h>
#import <math.h>
#import <string.h>

typedef void (*NCAudioSamples)(void *, const float *, const float *, size_t, int32_t);

// A Core Audio process tap never creates a ScreenCaptureKit/replayd client.
// All HAL objects are private and destroyed when the audio lease ends.
API_AVAILABLE(macos(14.2))
@interface NCCoreAudio : NSObject
@property(nonatomic) AudioObjectID tapID;
@property(nonatomic) AudioObjectID deviceID;
@property(nonatomic) AudioDeviceIOProcID ioProc;
@property(nonatomic) void *context;
@property(nonatomic) NCAudioSamples callback;
@property(nonatomic, strong) NSLock *gate;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) AVAudioFormat *inputFormat;
@property(nonatomic, strong) AVAudioConverter *converter;
@property(nonatomic, strong) AVAudioPCMBuffer *input;
@property(nonatomic, strong) AVAudioPCMBuffer *output;
@property(nonatomic) BOOL closed;
- (OSStatus)configureFormat:(AudioStreamBasicDescription)format;
- (void)consume:(const AudioBufferList *)buffers;
- (OSStatus)start;
- (OSStatus)stop;
@end

@implementation NCCoreAudio
- (instancetype)init {
    if ((self = [super init])) {
        _gate = [NSLock new];
        _queue = dispatch_queue_create("com.mostorm.nearhub.cast.core-audio", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}
- (OSStatus)configureFormat:(AudioStreamBasicDescription)format {
    if (format.mFormatID != kAudioFormatLinearPCM || format.mChannelsPerFrame != 2 ||
        format.mSampleRate < 8000 || format.mSampleRate > 192000 || !format.mBytesPerFrame) return -1005;
    self.inputFormat = [[AVAudioFormat alloc] initWithStreamDescription:&format];
    AVAudioFormat *target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:48000 channels:2 interleaved:YES];
    if (!self.inputFormat || !target) return -1005;
    self.converter = [[AVAudioConverter alloc] initFromFormat:self.inputFormat toFormat:target];
    self.input = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.inputFormat frameCapacity:(AVAudioFrameCount)ceil(format.mSampleRate)];
    self.output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:target frameCapacity:48000];
    return self.converter && self.input && self.output ? noErr : -1005;
}
- (void)consume:(const AudioBufferList *)buffers {
    [self.gate lock];
    if (self.closed || !buffers || !buffers->mNumberBuffers || !buffers->mBuffers[0].mDataByteSize) { [self.gate unlock];return; }
    const AudioStreamBasicDescription *format = self.inputFormat.streamDescription;
    UInt32 frames = buffers->mBuffers[0].mDataByteSize / format->mBytesPerFrame;
    BOOL valid = frames <= self.input.frameCapacity;
    self.input.frameLength = valid ? frames : 0;
    AudioBufferList *copy = self.input.mutableAudioBufferList;
    valid = valid && buffers->mNumberBuffers == copy->mNumberBuffers;
    for (UInt32 i = 0;valid && i < copy->mNumberBuffers;i++) {
        const AudioBuffer *source = &buffers->mBuffers[i];AudioBuffer *target = &copy->mBuffers[i];
        if (!source->mData || source->mDataByteSize != target->mDataByteSize || source->mNumberChannels != target->mNumberChannels) valid = NO;
        else memcpy(target->mData, source->mData, source->mDataByteSize);
    }
    if (!valid) { self.callback(self.context, NULL, NULL, 0, -1005);[self.gate unlock];return; }
    __block BOOL supplied = NO;
    NSError *error = nil;self.output.frameLength = 0;
    AVAudioConverterOutputStatus status = [self.converter convertToBuffer:self.output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
        (void)count;
        if (supplied) { *inputStatus = AVAudioConverterInputStatus_NoDataNow;return nil; }
        supplied = YES;*inputStatus = AVAudioConverterInputStatus_HaveData;return self.input;
    }];
    if (error || status == AVAudioConverterOutputStatus_Error) self.callback(self.context, NULL, NULL, 0, -1005);
    else if (self.output.frameLength) self.callback(self.context, self.output.audioBufferList->mBuffers[0].mData, NULL, self.output.frameLength, 0);
    [self.gate unlock];
}
- (OSStatus)start {
    NSMutableArray<NSNumber *> *excluded = [NSMutableArray new];
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) == noErr && size <= 1024 * 1024) {
        NSMutableData *objects = [NSMutableData dataWithLength:size];
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, objects.mutableBytes) == noErr) {
            const AudioObjectID *ids = objects.bytes;
            for (NSUInteger i = 0;i < size / sizeof(AudioObjectID);i++) {
                pid_t pid = 0;UInt32 pidSize = sizeof(pid);
                AudioObjectPropertyAddress pidAddress = {kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
                if (AudioObjectGetPropertyData(ids[i], &pidAddress, 0, NULL, &pidSize, &pid) != noErr) continue;
                CFStringRef bundle = NULL;UInt32 bundleSize = sizeof(bundle);
                AudioObjectPropertyAddress bundleAddress = {kAudioProcessPropertyBundleID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
                AudioObjectGetPropertyData(ids[i], &bundleAddress, 0, NULL, &bundleSize, &bundle);
                if (pid == getpid() || pid == getppid() || (bundle && [(__bridge NSString *)bundle isEqualToString:NSBundle.mainBundle.bundleIdentifier])) [excluded addObject:@(ids[i])];
                if (bundle) CFRelease(bundle);
            }
        }
    }
    CATapDescription *description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:excluded];
    description.name = @"NearHub Cast System Audio";description.privateTap = YES;description.muteBehavior = CATapUnmuted;
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
    // CI may build with an older SDK. Process-ID/bundle-ID enumeration above
    // remains the exclusion path when this newer declaration is unavailable.
    if (@available(macOS 26.0, *)) description.bundleIDs = NSBundle.mainBundle.bundleIdentifier ? @[NSBundle.mainBundle.bundleIdentifier] : @[];
#endif
    OSStatus result = AudioHardwareCreateProcessTap(description, &_tapID);
    if (result != noErr) return result;
    NSDictionary *composition = @{
        @kAudioAggregateDeviceNameKey: @"NearHub Cast System Audio",
        @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceIsStackedKey: @NO,
        @kAudioAggregateDeviceTapAutoStartKey: @YES,
        @kAudioAggregateDeviceTapListKey: @[@{@kAudioSubTapUIDKey: description.UUID.UUIDString, @kAudioSubTapDriftCompensationKey: @YES}],
    };
    result = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)composition, &_deviceID);
    if (result != noErr) return result;
    AudioStreamBasicDescription format = {0};size = sizeof(format);
    AudioObjectPropertyAddress formatAddress = {kAudioDevicePropertyStreamFormat, kAudioObjectPropertyScopeInput, kAudioObjectPropertyElementMain};
    result = AudioObjectGetPropertyData(self.deviceID, &formatAddress, 0, NULL, &size, &format);
    if (result != noErr) return result;
    result = [self configureFormat:format];if (result != noErr) return result;
    result = AudioDeviceCreateIOProcIDWithBlock(&_ioProc, self.deviceID, self.queue, ^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime, AudioBufferList *output, const AudioTimeStamp *outputTime) {
        (void)now;(void)inputTime;(void)output;(void)outputTime;[self consume:input];
    });
    if (result != noErr) return result;
    return AudioDeviceStart(self.deviceID, self.ioProc);
}
- (OSStatus)stop {
    [self.gate lock];self.closed = YES;[self.gate unlock];
    OSStatus failure = noErr,result;
    if (self.ioProc) {
        result = AudioDeviceStop(self.deviceID, self.ioProc);if (result != noErr) failure = result;
        result = AudioDeviceDestroyIOProcID(self.deviceID, self.ioProc);if (result != noErr) failure = result;
        if (result == noErr) self.ioProc = NULL;
    }
    if (self.deviceID) { result = AudioHardwareDestroyAggregateDevice(self.deviceID);if (result != noErr) failure = result;else self.deviceID = 0; }
    if (self.tapID) { result = AudioHardwareDestroyProcessTap(self.tapID);if (result != noErr) failure = result;else self.tapID = 0; }
    return failure;
}
@end

uint8_t nearcast_core_audio_available(void) { if (@available(macOS 14.2, *)) return 1;return 0; }
void *nearcast_core_audio_create(void *context, NCAudioSamples callback) {
    if (@available(macOS 14.2, *)) {
        NCCoreAudio *owner = [NCCoreAudio new];owner.context = context;owner.callback = callback;
        return (__bridge_retained void *)owner;
    }
    return NULL;
}
int32_t nearcast_core_audio_start(void *handle) { if (@available(macOS 14.2, *)) return [(__bridge NCCoreAudio *)handle start];return -1005; }
int32_t nearcast_core_audio_stop(void *handle) { if (@available(macOS 14.2, *)) return [(__bridge NCCoreAudio *)handle stop];return 0; }
void nearcast_core_audio_destroy(void *handle) { if (@available(macOS 14.2, *)) { __unused NCCoreAudio *owner = (__bridge_transfer NCCoreAudio *)handle; } }
