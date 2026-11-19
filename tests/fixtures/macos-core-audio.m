// Exercise the production converter with real AVAudioConverter buffers.
// No HAL device/tap is created, so this test never captures live audio.
#import "../../src-tauri/src/macos_core_audio.m"
#import <assert.h>

typedef struct { size_t frames; int error; double maximumMismatch; double energy; } Result;
static void collect(void *context, const float *samples, const float *right, size_t frames, int32_t error) {
    Result *result = context;
    if (error) { result->error = error;return; }
    assert(!right);
    for (size_t i = 0;i < frames;i++) {
        assert(isfinite(samples[i * 2]) && isfinite(samples[i * 2 + 1]));
        result->maximumMismatch = fmax(result->maximumMismatch, fabs(samples[i * 2] + 2 * samples[i * 2 + 1]));
        result->energy += samples[i * 2] * samples[i * 2];
    }
    result->frames += frames;
}
int main(void) {
    @autoreleasepool {
        if (@available(macOS 14.2, *)) {
            const double rates[] = {48000, 48000, 44100, 96000};
            for (int variant = 0;variant < 4;variant++) {
                double rate = rates[variant];BOOL interleaved = variant % 2 == 0;
                AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:2 interleaved:interleaved];
                NCCoreAudio *owner = [NCCoreAudio new];Result result = {0};owner.context = &result;owner.callback = collect;
                assert([owner configureFormat:*format.streamDescription] == noErr);
                AVAudioPCMBuffer *input = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:1024];input.frameLength = 1024;
                for (int chunk = 0;chunk < 30;chunk++) {
                    for (int i = 0;i < 1024;i++) {
                        float value = 0.2 * sin(2 * M_PI * 440 * (chunk * 1024 + i) / rate);
                        if (interleaved) { float *samples = input.mutableAudioBufferList->mBuffers[0].mData;samples[i * 2] = value;samples[i * 2 + 1] = -value * .5; }
                        else { input.floatChannelData[0][i] = value;input.floatChannelData[1][i] = -value * .5; }
                    }
                    [owner consume:input.audioBufferList];
                }
                double expected = 30 * 1024 * 48000 / rate;
                assert(!result.error && fabs(result.frames - expected) < 512 && result.maximumMismatch < 0.00001);
                assert(sqrt(result.energy / result.frames) > .1 && sqrt(result.energy / result.frames) < .2);
                size_t before = result.frames;[owner stop];[owner consume:input.audioBufferList];assert(result.frames == before);
                printf("PASS conversion %.0f Hz %s to 48000 Hz stereo: %zu frames\n", rate, interleaved ? "interleaved" : "planar", result.frames);
            }
            NCCoreAudio *owner = [NCCoreAudio new];Result result = {0};owner.context = &result;owner.callback = collect;
            AVAudioFormat *valid = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:48000 channels:2 interleaved:YES];
            AudioStreamBasicDescription bad = *valid.streamDescription;bad.mChannelsPerFrame = 3;
            assert([owner configureFormat:bad] == -1005);
            assert([owner configureFormat:*valid.streamDescription] == noErr);
            float samples[2] = {0};AudioBufferList buffer = {1, {{2, 7, samples}}};
            [owner consume:&buffer];assert(result.error == -1005);[owner stop];
            puts("PASS invalid formats/buffers and stopped callbacks are rejected");
        } else { puts("SKIP Core Audio taps require macOS 14.2"); }
    }
    return 0;
}
