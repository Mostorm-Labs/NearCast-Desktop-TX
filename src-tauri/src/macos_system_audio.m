#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>

typedef void (*NCAudioSamples)(void *, const float *, const float *, size_t, int32_t);

// All start/stop calls run on Rust's blocking pool. Only audio outputs are
// registered: browser video remains the sole video source sent to WebRTC.
@interface NCSystemAudio : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t samplesQueue;
@property(nonatomic, strong) NSLock *callbackGate;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL startPending;
@property(nonatomic) void *context;
@property(nonatomic) NCAudioSamples callback;
@end

@implementation NCSystemAudio
- (instancetype)init {
    if ((self = [super init])) {
        _samplesQueue = dispatch_queue_create("com.mostorm.nearhub.cast.system-audio", DISPATCH_QUEUE_SERIAL);
        _callbackGate = [NSLock new];
    }
    return self;
}
- (void)emitLeft:(const float *)left right:(const float *)right frames:(size_t)frames error:(int32_t)error {
    // Closing the gate waits for the current Rust callback and fences every
    // later framework callback before Rust can release its context pointer.
    [self.callbackGate lock];
    if (!self.closed) self.callback(self.context, left, right, frames, error);
    [self.callbackGate unlock];
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    [self emitLeft:NULL right:NULL frames:0 error:(int32_t)(error.code ?: -3802)];
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !CMSampleBufferIsValid(sample) || !CMSampleBufferDataIsReady(sample)) return;
    const AudioStreamBasicDescription *format = CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(sample));
    CMItemCount frames = CMSampleBufferGetNumSamples(sample);
    if (frames <= 0) return;
    if (!format || frames > 48000 || format->mSampleRate != 48000 || format->mChannelsPerFrame != 2 ||
        format->mFormatID != kAudioFormatLinearPCM || format->mBitsPerChannel != 32 ||
        !(format->mFormatFlags & kAudioFormatFlagIsFloat) || (format->mFormatFlags & kAudioFormatFlagIsBigEndian)) {
        [self emitLeft:NULL right:NULL frames:0 error:-1005];return;
    }
    struct { UInt32 count; AudioBuffer buffers[2]; } storage = {0};
    AudioBufferList *list = (AudioBufferList *)&storage;
    CMBlockBufferRef block = NULL;
    OSStatus result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, NULL, list, sizeof(storage),
        kCFAllocatorDefault, kCFAllocatorDefault, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block);
    if (result == noErr && list->mNumberBuffers == 2 && list->mBuffers[0].mNumberChannels == 1 && list->mBuffers[1].mNumberChannels == 1 &&
        list->mBuffers[0].mData && list->mBuffers[1].mData && list->mBuffers[0].mDataByteSize >= frames * sizeof(float) &&
        list->mBuffers[1].mDataByteSize >= frames * sizeof(float)) {
        [self emitLeft:list->mBuffers[0].mData right:list->mBuffers[1].mData frames:(size_t)frames error:0];
    } else if (result == noErr && list->mNumberBuffers == 1 && list->mBuffers[0].mNumberChannels == 2 &&
        list->mBuffers[0].mData && list->mBuffers[0].mDataByteSize >= frames * 2 * sizeof(float)) {
        [self emitLeft:list->mBuffers[0].mData right:NULL frames:(size_t)frames error:0];
    } else {
        [self emitLeft:NULL right:NULL frames:0 error:-1005];
    }
    if (block) CFRelease(block);
}
@end

void *nearcast_macos_audio_create(void *context, NCAudioSamples callback) {
    @autoreleasepool {
        NCSystemAudio *owner = [NCSystemAudio new];
        owner.context = context;owner.callback = callback;
        return (__bridge_retained void *)owner;
    }
}

int32_t nearcast_macos_audio_start(void *handle) {
    @autoreleasepool {
        if ([NSThread isMainThread]) return -1008;
        if (!CGPreflightScreenCaptureAccess()) return -3801;
        NCSystemAudio *owner = (__bridge NCSystemAudio *)handle;
        __block SCShareableContent *content;
        __block NSError *failure;
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *value, NSError *error) {
            content = value;failure = error;dispatch_semaphore_signal(ready);
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) return -1001;
        if (failure) return (int32_t)failure.code;
        SCDisplay *mainDisplay;
        for (SCDisplay *display in content.displays) if (display.displayID == CGMainDisplayID()) { mainDisplay = display;break; }
        if (!mainDisplay) return -1002;
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:mainDisplay excludingApplications:@[] exceptingWindows:@[]];
        SCStreamConfiguration *configuration = [SCStreamConfiguration new];
        configuration.width = 2;configuration.height = 2;
        configuration.minimumFrameInterval = CMTimeMake(1, 1);
        configuration.showsCursor = NO;
        configuration.capturesAudio = YES;
        configuration.sampleRate = 48000;configuration.channelCount = 2;
        configuration.excludesCurrentProcessAudio = YES;
        owner.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:owner];
        if (![owner.stream addStreamOutput:owner type:SCStreamOutputTypeAudio sampleHandlerQueue:owner.samplesQueue error:&failure]) return (int32_t)(failure.code ?: -3802);
        dispatch_semaphore_t started = dispatch_semaphore_create(0);
        owner.startPending = YES;
        [owner.stream startCaptureWithCompletionHandler:^(NSError *error) {
            [owner.callbackGate lock];owner.startPending = NO;[owner.callbackGate unlock];
            failure = error;dispatch_semaphore_signal(started);
        }];
        if (dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) return -1003;
        return failure ? (int32_t)failure.code : 0;
    }
}

int32_t nearcast_macos_audio_stop(void *handle) {
    @autoreleasepool {
        NCSystemAudio *owner = (__bridge NCSystemAudio *)handle;
        [owner.callbackGate lock];owner.closed = YES;[owner.callbackGate unlock];
        if (!owner.stream) return 0;
        __block NSError *failure;
        dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
        [owner.stream stopCaptureWithCompletionHandler:^(NSError *error) { failure = error;dispatch_semaphore_signal(stopped); }];
        if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC))) return -1004;
        if (failure && failure.code != SCStreamErrorAttemptToStopStreamState) return (int32_t)failure.code;
        [owner.callbackGate lock];BOOL pending = owner.startPending;[owner.callbackGate unlock];
        if (failure && pending) return -1004;
        [owner.stream removeStreamOutput:owner type:SCStreamOutputTypeAudio error:NULL];
        dispatch_sync(owner.samplesQueue, ^{});
        owner.stream = nil;
        return 0;
    }
}

void nearcast_macos_audio_destroy(void *handle) {
    @autoreleasepool { __unused NCSystemAudio *owner = (__bridge_transfer NCSystemAudio *)handle; }
}
