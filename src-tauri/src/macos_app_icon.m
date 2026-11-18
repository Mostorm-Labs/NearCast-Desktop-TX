#import <AppKit/AppKit.h>

uint8_t nearcast_macos_set_app_icon(const uint8_t *bytes, size_t length) {
    @autoreleasepool {
        if (![NSThread isMainThread] || !bytes || !length) return 0;
        NSData *data = [NSData dataWithBytes:bytes length:length];
        NSImage *image = [[NSImage alloc] initWithData:data];
        if (!image) return 0;
        [NSApplication sharedApplication].applicationIconImage = image;
        return 1;
    }
}
