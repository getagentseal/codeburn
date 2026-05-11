import Foundation

DistributedNotificationCenter.default().postNotificationName(
    .init("com.codeburn.refresh"),
    object: nil,
    userInfo: nil,
    options: .deliverImmediately
)
